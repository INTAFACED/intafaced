//! J-academy-07 (AC-commerce-01, AC-access-grants-01), ported from `purchases/course-purchases.db.test.ts`: buying a
//! course's certificate track from the buyer's own wallet, and the staff refund, against the real tables, with a fake
//! chain, ledger and refund signer the test drives.
//!
//! The TypeScript's fake ledger sat under `recipePosterOver`, so it saw the entries the recipe built. The Rust sends
//! svc-ledger the recipe's name and inputs (`postRecipe`) and never builds entries, so the fake here books the recipe
//! request, and the entry assertions become assertions on the recipe and its inputs (the entries are the ledger's
//! `academyPurchase` / `academyPurchaseRefund` recipes, tested in `packages/ledger-client`).
//!
//! Beyond the TypeScript file, one test per crash point of the money path: after the post key is claimed and before the
//! post; after the ledger booked and before the answer is saved; after the refund signer sent and before its hash is
//! stored.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex};

use service_kit::json::Json;
use service_kit::pg::Pool;
use support::TestDb;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;
use svc_academy::learner::learners::CourseLearners;
use svc_academy::learner::preview::CoursePreview;
use svc_academy::learner::purchases::chain::unread;
use svc_academy::learner::purchases::{CoursePurchases, Deps};
use svc_academy::ports::{
    Chain, Ledger, LinkedWallets, PaymentSettings, RefundSend, Refunds, TransferFact, TxFact,
};

const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const B: &str = "66666666-6666-4666-8666-666666666666";
const WALLET: &str = "0x00000000000000000000000000000000000000a1";
const TOKEN: &str = "0x000000000000000000000000000000000000d011";
const RECEIVER: &str = "0x7e57ac4d00000000000000000000000000000007";

fn settings() -> PaymentSettings {
    PaymentSettings {
        chain_id: 84532,
        token: TOKEN.to_owned(),
        decimals: 6,
        asset: "USDC".to_owned(),
        receiver: RECEIVER.to_owned(),
        confirmations: 2,
    }
}

/// The clock: the TypeScript calls Buy, Submit, Abandon, Refund and the reads with their default `new Date()`.
fn now() -> i64 {
    svc_academy::door::system_now().0
}
/// `NOW`, which the TypeScript passes to enrolling.
fn enrol_at() -> i64 {
    service_kit::time::js_date("2026-11-12T10:00:00.000Z")
        .unwrap()
        .0
}
fn hash(c: char) -> String {
    format!("0x{}", c.to_string().repeat(64))
}
fn pay_hash() -> String {
    hash('a')
}
fn other_hash() -> String {
    hash('b')
}
fn refund_tx() -> String {
    hash('c')
}
fn key() -> String {
    format!("academy:purchase:perps-101:{L}:1")
}
fn refund_key() -> String {
    format!("academy:refund:perps-101:{L}:1")
}

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

struct MinedTx {
    block: u64,
    reverted: bool,
    transfers: Vec<TransferFact>,
}

#[derive(Default)]
struct ChainState {
    head: u64,
    down: bool,
    broken: bool,
    txs: BTreeMap<String, MinedTx>,
}

/// A chain the test writes: mined transactions with their transfers, the head, and reads that can fail.
struct FakeChain(Mutex<ChainState>);

impl FakeChain {
    fn new() -> FakeChain {
        FakeChain(Mutex::new(ChainState {
            head: 100,
            ..ChainState::default()
        }))
    }
    fn mine(&self, hash: &str, transfers: &[(&str, &str, u128)], reverted: bool) {
        let mut s = self.0.lock().unwrap();
        s.head += 1;
        let block = s.head;
        let transfers = transfers
            .iter()
            .map(|(from, to, amount)| TransferFact {
                tx_hash: hash.to_owned(),
                block_number: block,
                from: (*from).to_owned(),
                to: (*to).to_owned(),
                amount: *amount,
            })
            .collect();
        s.txs.insert(
            hash.to_owned(),
            MinedTx {
                block,
                reverted,
                transfers,
            },
        );
    }
    fn set_tx(&self, hash: &str, block: u64, transfers: &[(&str, &str, u128)]) {
        let transfers = transfers
            .iter()
            .map(|(from, to, amount)| TransferFact {
                tx_hash: hash.to_owned(),
                block_number: block,
                from: (*from).to_owned(),
                to: (*to).to_owned(),
                amount: *amount,
            })
            .collect();
        self.0.lock().unwrap().txs.insert(
            hash.to_owned(),
            MinedTx {
                block,
                reverted: false,
                transfers,
            },
        );
    }
    fn advance(&self, n: u64) {
        self.0.lock().unwrap().head += n;
    }
    fn set_down(&self, down: bool) {
        self.0.lock().unwrap().down = down;
    }
    fn set_broken(&self, broken: bool) {
        self.0.lock().unwrap().broken = broken;
    }
}

impl Chain for FakeChain {
    fn block_number(&self) -> Result<u64, Refusal> {
        let s = self.0.lock().unwrap();
        if s.down {
            return Err(unread("node down".to_owned()));
        }
        Ok(s.head)
    }
    fn transaction(&self, tx_hash: &str, _token: &str) -> Result<TxFact, Refusal> {
        let s = self.0.lock().unwrap();
        if s.broken {
            return Err(Refusal::Internal {
                message: "the node answered nonsense".to_owned(),
                code: None,
            });
        }
        if s.down {
            return Err(unread("node down".to_owned()));
        }
        Ok(match s.txs.get(tx_hash) {
            None => TxFact::Unseen,
            Some(tx) if tx.reverted => TxFact::Reverted {
                block_number: tx.block,
            },
            Some(tx) => TxFact::Mined {
                block_number: tx.block,
                confirmations: s.head - tx.block + 1,
                transfers: tx.transfers.clone(),
            },
        })
    }
    fn transfers(
        &self,
        _token: &str,
        from: &str,
        to: &str,
        from_block: u64,
    ) -> Result<Vec<TransferFact>, Refusal> {
        let s = self.0.lock().unwrap();
        Ok(s.txs
            .values()
            .filter(|tx| !tx.reverted && tx.block >= from_block)
            .flat_map(|tx| tx.transfers.iter().cloned())
            .filter(|t| t.from == from && t.to == to)
            .collect())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Next {
    Ok,
    Lost,
    Refuse,
}

struct Booked {
    id: String,
    recipe: String,
    input: Json,
}

struct LedgerState {
    booked: BTreeMap<String, Booked>,
    calls: Vec<String>,
    next: Next,
}

/// A ledger that books each key once, as svc-ledger does, and can lose its answer or refuse.
struct FakeLedger(Mutex<LedgerState>);

impl FakeLedger {
    fn new() -> FakeLedger {
        FakeLedger(Mutex::new(LedgerState {
            booked: BTreeMap::new(),
            calls: Vec::new(),
            next: Next::Ok,
        }))
    }
    fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.clone()
    }
    fn booked(&self) -> usize {
        self.0.lock().unwrap().booked.len()
    }
    fn next(&self, n: Next) {
        self.0.lock().unwrap().next = n;
    }
    fn booked_as(&self, key: &str) -> (String, Json) {
        let s = self.0.lock().unwrap();
        let b = s.booked.get(key).unwrap();
        (b.recipe.clone(), b.input.clone())
    }
    /// Books `key` as the ledger would, without a call from the service: the post reached svc-ledger, and its answer
    /// never came back.
    fn book_behind(&self, key: &str, recipe: &str) {
        let mut s = self.0.lock().unwrap();
        let id = format!("tx-{}", s.booked.len() + 1);
        s.booked.insert(
            key.to_owned(),
            Booked {
                id,
                recipe: recipe.to_owned(),
                input: Json::Null,
            },
        );
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(
        &self,
        recipe: &str,
        idempotency_key: &str,
        input: &Json,
    ) -> Result<Json, Refusal> {
        let mut s = self.0.lock().unwrap();
        s.calls.push(idempotency_key.to_owned());
        let mode = s.next;
        s.next = Next::Ok;
        if mode == Next::Refuse {
            return Err(Refusal::Internal {
                message: "refused".to_owned(),
                code: Some("ledger.frozen".to_owned()),
            });
        }
        let size = s.booked.len();
        let id = s
            .booked
            .entry(idempotency_key.to_owned())
            .or_insert_with(|| Booked {
                id: format!("tx-{}", size + 1),
                recipe: recipe.to_owned(),
                input: input.clone(),
            })
            .id
            .clone();
        if mode == Next::Lost {
            return Err(Refusal::Internal {
                message: "fetch failed".to_owned(),
                code: None,
            });
        }
        Ok(Json::obj([("txId", Json::str(id))]))
    }
}

struct RefundState {
    sends: Vec<RefundSend>,
    answer_hash: bool,
    hold: bool,
}

struct FakeRefunds {
    state: Mutex<RefundState>,
    released: Condvar,
}

impl FakeRefunds {
    fn new() -> FakeRefunds {
        FakeRefunds {
            state: Mutex::new(RefundState {
                sends: Vec::new(),
                answer_hash: true,
                hold: false,
            }),
            released: Condvar::new(),
        }
    }
    fn sends(&self) -> Vec<RefundSend> {
        self.state.lock().unwrap().sends.clone()
    }
    fn answer_hash(&self, yes: bool) {
        self.state.lock().unwrap().answer_hash = yes;
    }
    fn hold(&self, yes: bool) {
        self.state.lock().unwrap().hold = yes;
        self.released.notify_all();
    }
}

impl Refunds for FakeRefunds {
    fn send(&self, input: &RefundSend) -> Result<Option<String>, Refusal> {
        let mut s = self.state.lock().unwrap();
        s.sends.push(input.clone());
        // Only the first send is held in flight: a second sender (a broken claim) answers at once, so the test fails
        // on the count instead of hanging.
        while s.hold && s.sends.len() == 1 {
            s = self.released.wait(s).unwrap();
        }
        Ok(s.answer_hash.then(refund_tx))
    }
}

/// Identity's linked wallets as the test sets them: the learner L links WALLET; None is identity unread.
struct FakeWallets(Mutex<Option<BTreeMap<String, Vec<String>>>>);

impl FakeWallets {
    fn new() -> FakeWallets {
        FakeWallets(Mutex::new(Some(BTreeMap::from([(
            L.to_owned(),
            vec![WALLET.to_owned()],
        )]))))
    }
    fn unread(&self) {
        *self.0.lock().unwrap() = None;
    }
}

impl LinkedWallets for FakeWallets {
    fn read(&self, user_id: &str) -> Option<Json> {
        let links = self.0.lock().unwrap();
        let links = links.as_ref()?;
        let wallets = links
            .get(user_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|address| {
                Json::obj([
                    ("address", Json::String(address)),
                    ("linkedAt", Json::str("2026-11-12T10:00:00.000Z")),
                ])
            })
            .collect();
        Some(Json::obj([
            ("state", Json::str("usable")),
            ("wallets", Json::Array(wallets)),
        ]))
    }
}

// ── The world ────────────────────────────────────────────────────────────────────────────────────────────────────────

struct World {
    db: TestDb,
    store: Store,
    chain: FakeChain,
    ledger: FakeLedger,
    refunds: FakeRefunds,
    wallets: FakeWallets,
    settings: PaymentSettings,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::migrated()?;
        let store = Store::Pool(Pool::new(&db.url, 8));
        Some(World {
            db,
            store,
            chain: FakeChain::new(),
            ledger: FakeLedger::new(),
            refunds: FakeRefunds::new(),
            wallets: FakeWallets::new(),
            settings: settings(),
        })
    }

    fn deps(&self, settings: bool, refunds: bool) -> Deps<'_> {
        Deps {
            settings: settings.then_some(&self.settings),
            chain: Some(&self.chain),
            ledger: Some(&self.ledger),
            refunds: refunds.then_some(&self.refunds as &dyn Refunds),
            wallets: Some(&self.wallets),
        }
    }
    fn purchases(&self) -> CoursePurchases<'_> {
        CoursePurchases {
            pool: &self.store,
            deps: self.deps(true, true),
        }
    }
    fn purchases_with(&self, settings: bool, refunds: bool) -> CoursePurchases<'_> {
        CoursePurchases {
            pool: &self.store,
            deps: self.deps(settings, refunds),
        }
    }

    fn sql(&self, statement: &str) {
        self.db.client().batch_execute(statement).unwrap();
    }

    /// A published paid course (`paidCourse`), created as `CourseRecords.create` does, then published.
    fn paid_course(&self, price: Option<&str>, asset: &str, slug: &str) {
        let title = if slug == "perps-101" {
            "Perps 101".to_owned()
        } else {
            format!("TEST {slug}")
        };
        let mut c = self.db.client();
        let at = "2026-11-12T10:00:00.000Z";
        let id: String = c
            .query_one(
                "INSERT INTO academy.courses \
                   (slug, title, summary, thumbnail_url, pricing, price, price_asset, state, revision, created_by, created_at, updated_at) \
                 VALUES ($1, $2, NULL, NULL, 'paid', '2.5', 'USDC', 'draft', 1, $3::text::uuid, $4::text::timestamptz, $4::text::timestamptz) \
                 RETURNING id::text",
                &[&slug, &title, &STAFF, &at],
            )
            .unwrap()
            .get(0);
        c.execute(
            "INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
             VALUES ($1::text::uuid, 1, 'created', NULL, 'draft', $2::text::uuid, NULL, $3::text::timestamptz)",
            &[&id, &STAFF, &at],
        )
        .unwrap();
        c.execute(
            "UPDATE academy.courses SET state = 'published', price_asset = $1 WHERE id = $2::text::uuid",
            &[&asset, &id],
        )
        .unwrap();
        // Staff withdrew the price after publishing: the only way a published paid course has none.
        if price.is_none() {
            c.execute(
                "UPDATE academy.courses SET price = NULL, price_asset = NULL, price_withdrawn_at = $1::text::timestamptz \
                 WHERE id = $2::text::uuid",
                &[&at, &id],
            )
            .unwrap();
        }
    }
    fn course(&self) {
        self.paid_course(Some("2.5"), "USDC", "perps-101");
    }

    fn pay(&self, hash: &str, amount: u128, from: &str, to: &str) {
        self.chain.mine(hash, &[(from, to, amount)], false);
    }
    fn pay_default(&self) {
        self.pay(&pay_hash(), 2_500_000, WALLET, RECEIVER);
    }

    fn rows(&self) -> Vec<(String, String, Option<String>)> {
        self.rows_by("n")
    }
    fn rows_by(&self, order: &str) -> Vec<(String, String, Option<String>)> {
        self.db
            .client()
            .query(&format!("SELECT purchase_key, state, tx_hash FROM academy.course_purchases ORDER BY {order}"), &[])
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect()
    }
    fn grants(&self) -> Vec<(String, String)> {
        self.db
            .client()
            .query("SELECT state, source FROM academy.access_grants", &[])
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }
    fn events(&self) -> Vec<(String, String, Option<String>, Option<String>)> {
        self.db
            .client()
            .query("SELECT kind, key, reason, actor_id::text FROM academy.access_grant_events ORDER BY n", &[])
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
            .collect()
    }
    fn truncate_all(&self) {
        let tables: Vec<String> = self.db.texts(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables \
             WHERE schemaname = 'academy' AND tablename NOT LIKE '%migrations%'",
        );
        self.sql(&format!(
            "TRUNCATE {} RESTART IDENTITY CASCADE",
            tables.join(", ")
        ));
    }

    fn terms(&self, purchases: &CoursePurchases<'_>) -> Json {
        let learners = CourseLearners {
            pool: &self.store,
            preview: CoursePreview { pool: &self.store },
            purchases,
        };
        learners.terms(L, "perps-101").unwrap()
    }
    fn enrol(&self, purchases: &CoursePurchases<'_>, track: &str) -> Result<Json, Refusal> {
        let learners = CourseLearners {
            pool: &self.store,
            preview: CoursePreview { pool: &self.store },
            purchases,
        };
        learners.enrol(L, "perps-101", track, enrol_at())
    }
    fn reconcile(&self, purchases: &CoursePurchases<'_>) -> usize {
        purchases.reconcile(100, &mut |_, _| {}).unwrap()
    }
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("expected an academy refusal, got {other:?}"),
    }
}

/// The value at a dotted path, or Null.
fn at<'a>(j: &'a Json, path: &str) -> &'a Json {
    path.split('.')
        .try_fold(j, |j, k| j.get(k))
        .unwrap_or(&Json::Null)
}
fn s(j: &Json, path: &str) -> Option<String> {
    match at(j, path) {
        Json::String(v) => Some(v.clone()),
        _ => None,
    }
}
fn row(key: &str, state: &str, tx: Option<&str>) -> (String, String, Option<String>) {
    (key.to_owned(), state.to_owned(), tx.map(str::to_owned))
}
fn track_closed(terms: &Json) -> Json {
    match at(terms, "tracks") {
        Json::Array(t) => t[1].get("closed").cloned().unwrap(),
        _ => panic!("no tracks"),
    }
}

macro_rules! world {
    () => {
        match World::new() {
            Some(w) => w,
            None => return,
        }
    };
}

// ── The TypeScript file's tests ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn tracks_no_price_closes_no_price_payments_off_closes_payments_off_priced_and_set_up_opens_it() {
    let w = world!();
    w.paid_course(None, "USDC", "perps-101");
    let p = w.purchases();
    let terms = w.terms(&p);
    let Json::Array(tracks) = at(&terms, "tracks") else {
        panic!()
    };
    assert_eq!(
        tracks[1],
        Json::obj([
            ("track", Json::str("certificate")),
            ("free", Json::Bool(false)),
            ("closed", Json::str("no_price"))
        ])
    );
    assert_eq!(
        code(p.buy(L, "perps-101", WALLET, now())),
        "academy.price_unset"
    );
    w.sql("UPDATE academy.courses SET price = '2.5', price_asset = 'USDC'");
    assert_eq!(track_closed(&w.terms(&p)), Json::Null);
    // Priced in an asset the payment token is not: not sold.
    w.sql("UPDATE academy.courses SET price_asset = 'USDT'");
    assert_eq!(track_closed(&w.terms(&p)), Json::str("payments_off"));
    let off = w.purchases_with(false, true);
    w.sql("UPDATE academy.courses SET price_asset = 'USDC'");
    assert_eq!(track_closed(&w.terms(&off)), Json::str("payments_off"));
    assert_eq!(
        code(off.buy(L, "perps-101", WALLET, now())),
        "academy.payments_off"
    );
    assert!(w.rows().is_empty());
}

#[test]
fn a_payer_must_be_the_buyers_own_linked_wallet() {
    let w = world!();
    w.course();
    let p = w.purchases();
    // B names L's wallet: refused, so no intent of B's can ever match L's transfer.
    assert_eq!(
        code(p.buy(B, "perps-101", WALLET, now())),
        "academy.wallet_not_linked"
    );
    assert!(w.rows().is_empty());
    // L pays; the reconciler counts it for L only, and B has nothing to claim it with.
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.reconcile(&p);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&pay_hash()))]);
    assert_eq!(
        code(p.submit_payment(B, &key(), &pay_hash(), now())),
        "academy.purchase_not_found"
    );
    // A wallet linked to nobody, and identity unread, refuse and open nothing.
    assert_eq!(
        code(p.buy(B, "perps-101", &other_hash()[..42], now())),
        "academy.wallet_not_linked"
    );
    w.wallets.unread();
    assert_eq!(
        code(p.buy(B, "perps-101", WALLET, now())),
        "academy.wallet_unread"
    );
    assert_eq!(w.rows().len(), 1);
}

#[test]
fn enrolling_on_the_paid_track_needs_a_recorded_purchase() {
    let w = world!();
    w.course();
    let p = w.purchases();
    assert_eq!(code(w.enrol(&p, "certificate")), "academy.payment_required");
    assert_eq!(
        s(&w.enrol(&p, "audit").unwrap(), "enrolment.track").as_deref(),
        Some("audit")
    );
}

#[test]
fn buy_stores_the_intent_and_asks_for_one_signature_a_second_buy_answers_the_same_purchase_with_no_request()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    assert_eq!(
        code(p.buy(L, "perps-101", "not-a-wallet", now())),
        "academy.wallet_invalid"
    );
    let upper = WALLET.to_uppercase().replace("0X", "0x");
    let first = p.buy(L, "perps-101", &upper, now()).unwrap();
    let data = format!(
        "0xa9059cbb{:0>64}{:0>64}",
        &RECEIVER[2..],
        format!("{:x}", 2_500_000)
    );
    assert_eq!(
        *at(&first, "request"),
        Json::obj([
            ("chainId", Json::int(84532)),
            ("to", Json::str(TOKEN)),
            ("data", Json::String(data))
        ])
    );
    assert_eq!(s(&first, "purchase.key"), Some(key()));
    assert_eq!(
        s(&first, "purchase.state").as_deref(),
        Some("awaiting_signature")
    );
    assert_eq!(s(&first, "purchase.amount").as_deref(), Some("2.5"));
    assert_eq!(s(&first, "purchase.asset").as_deref(), Some("USDC"));
    assert_eq!(s(&first, "purchase.payer").as_deref(), Some(WALLET));
    assert_eq!(*at(&first, "purchase.grant"), Json::Null);
    let twice: Vec<Json> = std::thread::scope(|scope| {
        let hs: Vec<_> = (0..2)
            .map(|_| scope.spawn(|| p.buy(L, "perps-101", WALLET, now()).unwrap()))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for again in twice {
        assert_eq!(*at(&again, "request"), Json::Null);
        assert_eq!(s(&again, "purchase.key"), Some(key()));
        assert_eq!(
            s(&again, "purchase.state").as_deref(),
            Some("awaiting_signature")
        );
    }
    assert_eq!(w.rows().len(), 1);
}

/// Ten rounds of six: one round of three let the purchase_key race through on main once (#8378).
#[test]
fn two_first_presses_at_once_open_one_intent_and_only_one_answer_carries_the_request() {
    let w = world!();
    for round in 1..=10 {
        w.truncate_all();
        w.course();
        let p = w.purchases();
        let answers: Vec<Json> = std::thread::scope(|scope| {
            let hs: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| p.buy(L, "perps-101", WALLET, now()).unwrap()))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let with_request = answers
            .iter()
            .filter(|a| *at(a, "request") != Json::Null)
            .count();
        assert_eq!(with_request, 1, "round {round}");
        assert_eq!(w.rows().len(), 1, "round {round}");
    }
}

#[test]
fn a_rejected_signature_leaves_no_purchase_buy_again_reopens_the_same_key_and_asks_once_more() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    let gone = p.abandon(L, &key(), now()).unwrap();
    assert_eq!(*at(&gone, "purchase"), Json::Null);
    let again = p.buy(L, "perps-101", WALLET, now()).unwrap();
    assert_ne!(*at(&again, "request"), Json::Null);
    assert_eq!(s(&again, "purchase.key"), Some(key()));
    assert_eq!(w.rows(), vec![row(&key(), "awaiting_signature", None)]);
    // Another learner cannot touch it.
    assert_eq!(
        code(p.abandon(STAFF, &key(), now())),
        "academy.purchase_not_found"
    );
}

#[test]
fn a_set_aside_intent_whose_payment_did_go_out_is_found_on_the_chain_never_left_abandoned() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    let view = p.abandon(L, &key(), now()).unwrap();
    assert_eq!(s(&view, "purchase.state").as_deref(), Some("submitted"));
    assert_eq!(s(&view, "purchase.txHash"), Some(pay_hash()));
}

#[test]
fn a_payment_sent_but_not_yet_mined_when_set_aside_is_found_by_the_reconciler_once_mined_and_posted_once()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    // The wallet sent it, its answer was lost, and the learner set the intent aside before it was mined.
    assert_eq!(
        *at(&p.abandon(L, &key(), now()).unwrap(), "purchase"),
        Json::Null
    );
    assert_eq!(w.rows(), vec![row(&key(), "abandoned", None)]);
    w.pay_default();
    w.chain.advance(1);
    w.reconcile(&p);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&pay_hash()))]);
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(
        w.grants(),
        vec![("granted".to_owned(), "purchase".to_owned())]
    );
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
}

#[test]
fn a_reopened_intent_keeps_its_first_block_so_a_payment_sent_before_it_was_set_aside_is_still_found()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    let first =
        w.db.texts("SELECT from_block::text FROM academy.course_purchases")[0].clone();
    p.abandon(L, &key(), now()).unwrap();
    // Blocks pass, then Buy again: one intent, the same key and the same first block.
    w.chain.advance(5);
    let again = p.buy(L, "perps-101", WALLET, now()).unwrap();
    assert_ne!(*at(&again, "request"), Json::Null);
    let reopened =
        w.db.texts("SELECT from_block::text FROM academy.course_purchases")[0].clone();
    assert_eq!(reopened, first);
    // The first send is mined at a block before the reopen would have started: it is found and counted once.
    let block: u64 = first.parse::<u64>().unwrap() + 1;
    w.chain
        .set_tx(&pay_hash(), block, &[(WALLET, RECEIVER, 2_500_000)]);
    w.chain.advance(1);
    w.reconcile(&p);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&pay_hash()))]);
    assert_eq!(w.ledger.calls(), vec![key()]);
}

#[test]
fn the_grant_appears_only_after_the_payment_confirmed_and_posted_once_under_the_purchase_key() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    // Sent, not yet mined: waits.
    let sent = p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    assert_eq!(s(&sent, "purchase.state").as_deref(), Some("submitted"));
    assert_eq!(*at(&sent, "purchase.grant"), Json::Null);
    w.pay_default();
    // One confirmation of the owner's two: still waiting, nothing posted, no grant.
    let waiting = p.view(L, "perps-101").unwrap();
    assert_eq!(s(&waiting, "purchase.state").as_deref(), Some("submitted"));
    assert_eq!(*at(&waiting, "purchase.grant"), Json::Null);
    assert!(w.ledger.calls().is_empty());
    assert!(w.grants().is_empty());
    w.chain.advance(1);
    let posted = p.view(L, "perps-101").unwrap();
    assert_eq!(s(&posted, "purchase.state").as_deref(), Some("posted"));
    assert_eq!(s(&posted, "purchase.grant").as_deref(), Some("granted"));
    assert_eq!(s(&posted, "purchase.txHash"), Some(pay_hash()));
    assert_eq!(w.ledger.calls(), vec![key()]);
    // The TypeScript asserted the entries `academyPurchase` built (2.5 at 18 places, debit then credit); the Rust
    // names the recipe and its inputs, and the ledger's recipe builds the entries.
    let (recipe, input) = w.ledger.booked_as(&key());
    assert_eq!(recipe, "academyPurchase");
    assert_eq!(s(&input, "amount").as_deref(), Some("2.5"));
    assert_eq!(s(&input, "assetId").as_deref(), Some("USDC"));
    assert_eq!(s(&input, "course").as_deref(), Some("perps-101"));
    assert_eq!(s(&input, "userId").as_deref(), Some(L));
    assert_eq!(s(&input, "n").as_deref(), Some("1"));
    assert_eq!(s(&input, "paymentId"), Some(pay_hash()));
    assert_eq!(s(&input, "to.kind").as_deref(), Some("treasury-wallet"));
    assert_eq!(s(&input, "to.walletId").as_deref(), Some(RECEIVER));
    assert_eq!(
        w.grants(),
        vec![("granted".to_owned(), "purchase".to_owned())]
    );
    assert_eq!(
        w.events(),
        vec![(
            "granted".to_owned(),
            format!("purchase:{}", key()),
            None,
            Some(L.to_owned())
        )]
    );
    assert_eq!(
        s(&w.enrol(&p, "certificate").unwrap(), "enrolment.track").as_deref(),
        Some("certificate")
    );
    // Read again and reconciled again: no second post.
    w.reconcile(&p);
    p.view(L, "perps-101").unwrap();
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "ledgerTxId").as_deref(),
        Some("tx-1")
    );
}

#[test]
fn a_lost_report_of_the_sent_payment_is_settled_from_the_chain_one_purchase_one_post() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    assert_eq!(w.reconcile(&p), 1);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&pay_hash()))]);
    assert_eq!(w.ledger.calls(), vec![key()]);
    // The hash reported late changes nothing.
    let late = p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    assert_eq!(s(&late, "purchase.state").as_deref(), Some("posted"));
    assert_eq!(w.ledger.calls(), vec![key()]);
}

#[test]
fn a_transfer_of_another_amount_or_one_already_counted_is_not_taken_for_the_payment() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay(&other_hash(), 1_000_000, WALLET, RECEIVER);
    w.reconcile(&p);
    assert_eq!(w.rows()[0].1, "awaiting_signature");
}

#[test]
fn a_reverted_payment_or_one_that_paid_something_else_fails_with_no_grant_buy_then_opens_the_same_key_again()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.chain.mine(&pay_hash(), &[], true);
    let failed = p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    assert_eq!(s(&failed, "purchase.state").as_deref(), Some("failed"));
    assert_eq!(
        s(&failed, "purchase.failure").as_deref(),
        Some("payment_reverted")
    );
    assert_eq!(*at(&failed, "purchase.grant"), Json::Null);
    let again = p.buy(L, "perps-101", WALLET, now()).unwrap();
    assert_ne!(*at(&again, "request"), Json::Null);
    w.pay(
        &other_hash(),
        2_500_000,
        WALLET,
        "0x00000000000000000000000000000000000000ee",
    );
    w.chain.advance(2);
    let mismatch = p.submit_payment(L, &key(), &other_hash(), now()).unwrap();
    assert_eq!(s(&mismatch, "purchase.state").as_deref(), Some("failed"));
    assert_eq!(
        s(&mismatch, "purchase.failure").as_deref(),
        Some("payment_mismatch")
    );
    assert!(w.ledger.calls().is_empty());
    assert!(w.grants().is_empty());
}

#[test]
fn one_purchase_whose_read_fails_is_reported_with_its_key_the_others_still_move() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    w.chain.set_broken(true);
    let mut failed = Vec::new();
    assert_eq!(
        p.reconcile(100, &mut |k, _| failed.push(k.to_owned()))
            .unwrap(),
        1
    );
    assert_eq!(failed, vec![key()]);
    w.chain.set_broken(false);
    assert_eq!(w.rows()[0].1, "submitted");
}

#[test]
fn an_unreadable_node_is_not_no_payment_the_purchase_stays_where_it_was() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    w.chain.set_down(true);
    assert_eq!(
        s(&p.view(L, "perps-101").unwrap(), "purchase.state").as_deref(),
        Some("submitted")
    );
    assert_eq!(
        *at(&p.buy(L, "perps-101", WALLET, now()).unwrap(), "request"),
        Json::Null
    );
}

#[test]
fn a_lost_ledger_answer_is_posted_again_on_the_same_key_and_booked_once_a_refusal_is_posted_again_after_the_deadline()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.ledger.next(Next::Lost);
    let lost = p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    assert_eq!(s(&lost, "purchase.state").as_deref(), Some("confirmed"));
    assert_eq!(*at(&lost, "purchase.grant"), Json::Null);
    assert!(w.grants().is_empty());
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key(), key()]);
    assert_eq!(w.ledger.booked(), 1);
    assert_eq!(w.rows()[0].1, "posted");

    // A fresh world for the refusal half (the TypeScript truncates and makes a new ledger).
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay(&other_hash(), 2_500_000, WALLET, RECEIVER);
    w.chain.advance(1);
    w.ledger.next(Next::Refuse);
    let refused = p.submit_payment(L, &key(), &other_hash(), now()).unwrap();
    assert_eq!(s(&refused, "purchase.state").as_deref(), Some("confirmed"));
    assert_eq!(
        s(&refused, "purchase.failure").as_deref(),
        Some("ledger.frozen")
    );
    assert_eq!(*at(&refused, "purchase.grant"), Json::Null);
    // Within the post deadline it is not posted again; after it (the freeze lifted), it is, once, on the same key.
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
    w.sql("UPDATE academy.course_purchases SET updated_at = now() - interval '5 minutes'");
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key(), key()]);
    assert_eq!(w.ledger.booked(), 1);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&other_hash()))]);
}

#[test]
fn a_crash_while_posting_is_taken_again_only_after_the_post_deadline() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.sql(&format!(
        "UPDATE academy.course_purchases SET state = 'confirmed', tx_hash = '{}', post_state = 'posting', updated_at = now()",
        pay_hash()
    ));
    w.reconcile(&p);
    assert!(w.ledger.calls().is_empty());
    w.sql("UPDATE academy.course_purchases SET updated_at = now() - interval '5 minutes'");
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(w.rows()[0].1, "posted");
}

#[test]
fn a_staff_refund_stored_with_its_reason_and_who_sent_once_under_its_key_posted_once_as_the_reverse_and_the_grant_revoked()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    w.enrol(&p, "certificate").unwrap();

    assert_eq!(
        code(p.refund(&key(), "  ", STAFF, now())),
        "academy.reason_required"
    );
    assert_eq!(
        code(p.refund("academy:purchase:nope", "r", STAFF, now())),
        "academy.purchase_not_found"
    );
    w.refunds.answer_hash(false);
    let refunding = p
        .refund(&key(), "asked within the window", STAFF, now())
        .unwrap();
    assert_eq!(s(&refunding, "state").as_deref(), Some("refunding"));
    assert_eq!(*at(&refunding, "refund.txHash"), Json::Null);
    assert_eq!(
        s(&refunding, "refund.reason").as_deref(),
        Some("asked within the window")
    );
    // The signer's answer was lost: asked again under the same key, which answers the same transaction.
    w.refunds.answer_hash(true);
    w.reconcile(&p);
    let send = RefundSend {
        key: refund_key(),
        chain_id: 84532,
        token: TOKEN.to_owned(),
        to: WALLET.to_owned(),
        amount: 2_500_000,
    };
    assert_eq!(w.refunds.sends(), vec![send.clone(), send]);
    // Sent, not yet confirmed twice: no reverse post, the grant stands.
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "state").as_deref(),
        Some("refunding")
    );
    assert_eq!(w.ledger.calls(), vec![key()]);
    w.chain
        .mine(&refund_tx(), &[(RECEIVER, WALLET, 2_500_000)], false);
    w.chain.advance(1);
    let refunded = p.staff_read(&key()).unwrap();
    assert_eq!(s(&refunded, "state").as_deref(), Some("refunded"));
    assert_eq!(s(&refunded, "grant").as_deref(), Some("revoked"));
    assert_eq!(s(&refunded, "refund.txHash"), Some(refund_tx()));
    assert_eq!(
        s(&refunded, "refund.reason").as_deref(),
        Some("asked within the window")
    );
    assert_eq!(s(&refunded, "refundLedgerTxId").as_deref(), Some("tx-2"));
    assert_eq!(w.ledger.calls(), vec![key(), refund_key()]);
    // The TypeScript asserted the reverse entries (credit, debit); the Rust names the refund recipe, paid from the
    // treasury wallet.
    let (recipe, input) = w.ledger.booked_as(&refund_key());
    assert_eq!(recipe, "academyPurchaseRefund");
    assert_eq!(s(&input, "amount").as_deref(), Some("2.5"));
    assert_eq!(s(&input, "from.kind").as_deref(), Some("treasury-wallet"));
    assert_eq!(*at(&input, "to"), Json::Null);
    assert_eq!(
        w.grants(),
        vec![("revoked".to_owned(), "purchase".to_owned())]
    );
    assert_eq!(
        w.events().last().cloned(),
        Some((
            "revoked".to_owned(),
            format!("refund:{}", refund_key()),
            Some("asked within the window".to_owned()),
            Some(STAFF.to_owned())
        ))
    );
    assert_eq!(*at(&w.terms(&p), "enrolment"), Json::Null);
    assert_eq!(code(w.enrol(&p, "certificate")), "academy.payment_required");
    // A repeat answers the same refund; nothing is sent or posted again.
    assert_eq!(
        s(&p.refund(&key(), "again", STAFF, now()).unwrap(), "state").as_deref(),
        Some("refunded")
    );
    w.reconcile(&p);
    assert_eq!(w.refunds.sends().len(), 2);
    assert_eq!(w.ledger.calls(), vec![key(), refund_key()]);
    // Bought again after the refund: a new purchase, n = 2.
    let next = p.buy(L, "perps-101", WALLET, now()).unwrap();
    assert_eq!(
        s(&next, "purchase.key"),
        Some(format!("academy:purchase:perps-101:{L}:2"))
    );
}

#[test]
fn a_refund_is_sent_by_one_caller_at_a_time_a_staff_read_a_view_and_the_reconciler_arriving_mid_send_send_nothing_more()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    w.refunds.hold(true);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            p.refund(&key(), "asked within the window", STAFF, now())
                .unwrap()
        });
        let started = std::time::Instant::now();
        while w.refunds.sends().is_empty() {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "the first send never started"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // While the first send is in flight, every other way in reaches the refund and sends nothing.
        std::thread::scope(|inner| {
            inner.spawn(|| w.reconcile(&p));
            inner.spawn(|| p.staff_read(&key()).unwrap());
            inner.spawn(|| p.view(L, "perps-101").unwrap());
        });
        // Counted before the hold is released, and asserted after: a failure never leaves the first send held.
        let mid_send = w.refunds.sends().len();
        w.refunds.hold(false);
        assert_eq!(mid_send, 1, "a caller arriving mid-send sent again");
        let first = first.join().unwrap();
        assert_eq!(s(&first, "state").as_deref(), Some("refunding"));
        assert_eq!(s(&first, "refund.txHash"), Some(refund_tx()));
    });
    w.reconcile(&p);
    assert_eq!(w.refunds.sends().len(), 1);
}

#[test]
fn a_transfer_two_open_intents_of_the_same_wallet_could_both_have_paid_is_taken_for_neither_until_the_wallet_reports_its_hash()
 {
    let w = world!();
    w.course();
    w.paid_course(Some("2.5"), "USDC", "perps-102");
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    p.buy(L, "perps-102", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.reconcile(&p);
    let states: Vec<String> = w.rows().into_iter().map(|r| r.1).collect();
    assert_eq!(states, vec!["awaiting_signature", "awaiting_signature"]);
    assert!(w.ledger.calls().is_empty());
    // The wallet's reported hash says which course it paid: that one only.
    let key_102 = format!("academy:purchase:perps-102:{L}:1");
    p.submit_payment(L, &key_102, &pay_hash(), now()).unwrap();
    w.reconcile(&p);
    assert_eq!(
        w.rows_by("purchase_key"),
        vec![
            row(&key(), "awaiting_signature", None),
            row(&key_102, "posted", Some(&pay_hash()))
        ]
    );
    assert_eq!(w.ledger.calls(), vec![key_102]);
}

#[test]
fn a_purchase_not_yet_recorded_cannot_be_refunded_a_refund_transaction_that_sends_something_else_is_stopped_never_sent_again()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    assert_eq!(
        code(p.refund(&key(), "r", STAFF, now())),
        "academy.purchase_state"
    );
    w.pay_default();
    w.chain.advance(1);
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    p.refund(&key(), "r", STAFF, now()).unwrap();
    w.chain.mine(&refund_tx(), &[(RECEIVER, WALLET, 1)], false);
    w.chain.advance(1);
    w.reconcile(&p);
    w.reconcile(&p);
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "state").as_deref(),
        Some("refunding")
    );
    assert_eq!(w.refunds.sends().len(), 1);
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(
        w.grants(),
        vec![("granted".to_owned(), "purchase".to_owned())]
    );
}

#[test]
fn with_no_refund_signer_a_refund_refuses_by_name_and_nothing_changes() {
    let w = world!();
    w.course();
    let p = w.purchases_with(true, false);
    assert_eq!(
        code(p.refund(&key(), "r", STAFF, now())),
        "academy.refund_sender_unset"
    );
}

// ── Crash points of the money path (beyond the TypeScript file) ──────────────────────────────────────────────────────

/// Crash after the post key is claimed (`post_state = 'posting'`) and before the ledger was asked: nothing booked, and
/// the reconciler posts it once, on the same key, after the deadline (never twice within it).
#[test]
fn crash_after_the_key_is_claimed_before_the_post_posts_once_on_the_same_key_after_the_deadline() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.sql(&format!(
        "UPDATE academy.course_purchases SET state = 'confirmed', tx_hash = '{}', post_state = 'posting', \
         updated_at = now() - interval '29 seconds'",
        pay_hash()
    ));
    // Within the 30 s deadline the claim stands: a view, a submit and the reconciler post nothing.
    p.view(L, "perps-101").unwrap();
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    assert!(w.ledger.calls().is_empty());
    assert!(w.grants().is_empty());
    w.sql("UPDATE academy.course_purchases SET updated_at = now() - interval '31 seconds'");
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(w.ledger.booked(), 1);
    assert_eq!(w.rows(), vec![row(&key(), "posted", Some(&pay_hash()))]);
    assert_eq!(
        w.grants(),
        vec![("granted".to_owned(), "purchase".to_owned())]
    );
}

/// Crash after svc-ledger booked the post and before its answer was saved: the row still says `posting`; after the
/// deadline the same key is posted again, the ledger answers the transaction it already booked, and the money is
/// booked once with one grant.
#[test]
fn crash_after_the_post_before_the_answer_is_saved_books_once() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    w.sql(&format!(
        "UPDATE academy.course_purchases SET state = 'confirmed', tx_hash = '{}', post_state = 'posting', \
         updated_at = now() - interval '5 minutes'",
        pay_hash()
    ));
    w.ledger.book_behind(&key(), "academyPurchase");
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
    assert_eq!(w.ledger.booked(), 1);
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "ledgerTxId").as_deref(),
        Some("tx-1")
    );
    assert_eq!(
        w.grants(),
        vec![("granted".to_owned(), "purchase".to_owned())]
    );
    assert_eq!(w.events().len(), 1);
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key()]);
}

/// Crash after the refund signer sent and before its hash was stored: the claim (`refund_send_at`) stands, so within
/// the deadline nobody sends again; after it the signer is asked again under the same key (which answers the same
/// transaction), the hash is stored, and the reverse is posted once.
#[test]
fn crash_after_the_refund_signer_sent_before_the_hash_is_stored_asks_again_on_the_same_key_after_the_deadline()
 {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    // The refund is stored with no signer, as if the process died before asking.
    let none = w.purchases_with(true, false);
    assert_eq!(
        code(none.refund(&key(), "r", STAFF, now())),
        "academy.refund_sender_unset"
    );
    // Store the refund, then claim the send as a process that died mid-send would have left it.
    w.refunds.answer_hash(false);
    p.refund(&key(), "r", STAFF, now()).unwrap();
    assert_eq!(w.refunds.sends().len(), 1);
    w.sql("UPDATE academy.course_purchases SET refund_send_at = now() - interval '10 seconds'");
    w.refunds.answer_hash(true);
    w.reconcile(&p);
    p.staff_read(&key()).unwrap();
    assert_eq!(
        w.refunds.sends().len(),
        1,
        "a claimed send is not sent again within the deadline"
    );
    assert_eq!(
        w.db.texts("SELECT coalesce(refund_tx_hash, 'none') FROM academy.course_purchases"),
        vec!["none"]
    );
    w.sql("UPDATE academy.course_purchases SET refund_send_at = now() - interval '31 seconds'");
    w.reconcile(&p);
    let sends = w.refunds.sends();
    assert_eq!(sends.len(), 2);
    assert!(sends.iter().all(|s| s.key == refund_key()));
    assert_eq!(
        w.db.texts("SELECT refund_tx_hash FROM academy.course_purchases"),
        vec![refund_tx()]
    );
    w.chain
        .mine(&refund_tx(), &[(RECEIVER, WALLET, 2_500_000)], false);
    w.chain.advance(1);
    w.reconcile(&p);
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key(), refund_key()]);
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "state").as_deref(),
        Some("refunded")
    );
}

/// A refused reverse post (a frozen ledger) keeps the grant and the refund open; after the deadline it is posted once on
/// the same refund key.
#[test]
fn a_refused_reverse_post_is_posted_again_on_the_same_key_after_the_deadline() {
    let w = world!();
    w.course();
    let p = w.purchases();
    p.buy(L, "perps-101", WALLET, now()).unwrap();
    w.pay_default();
    w.chain.advance(1);
    p.submit_payment(L, &key(), &pay_hash(), now()).unwrap();
    p.refund(&key(), "r", STAFF, now()).unwrap();
    w.chain
        .mine(&refund_tx(), &[(RECEIVER, WALLET, 2_500_000)], false);
    w.chain.advance(1);
    w.ledger.next(Next::Refuse);
    let held = p.staff_read(&key()).unwrap();
    assert_eq!(s(&held, "state").as_deref(), Some("refunding"));
    assert_eq!(s(&held, "grant").as_deref(), Some("granted"));
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key(), refund_key()]);
    w.sql("UPDATE academy.course_purchases SET updated_at = now() - interval '5 minutes'");
    w.reconcile(&p);
    assert_eq!(w.ledger.calls(), vec![key(), refund_key(), refund_key()]);
    assert_eq!(w.ledger.booked(), 2);
    assert_eq!(
        s(&p.staff_read(&key()).unwrap(), "state").as_deref(),
        Some("refunded")
    );
    assert_eq!(
        w.grants(),
        vec![("revoked".to_owned(), "purchase".to_owned())]
    );
}
