//! The `controls` slice against a real Postgres (`ledger/reconciliation-controls.pg.test.ts`, case for case), each test in
//! its own throwaway database (`support`). Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Two of the TypeScript file's cases live in `tests/ops_reads_pg.rs`, the slice that owns their reads: "feeds settled
//! evaluations oldest first to svc-ops" and "answers which asked transaction ids are booked". The tRPC router's case
//! ("lists controls for compliance and refuses a treasury define without a second factor") is asked of the operator door,
//! the Rust port's one way in.
//!
//! The TypeScript cases share one database, so a later case sees what earlier ones left. Each Rust case starts empty and
//! plants what its TypeScript case relied on, saying so where it does. Outside sources are a real HTTP server on a local
//! port read through the real client, as the TypeScript's Fastify server and `fetch` are.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use postgres::{Client, NoTls};
use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::{Outcome, Value};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};
use support::TestDb;
use support::operator::{Shared, Stub, bearer, call, code as door_code, door_config, stub};
use svc_ledger::approval::{Approvals, Refused};
use svc_ledger::clock::{read_database_now, system_ms};
use svc_ledger::controls::sources::{
    Http, OUTSIDE_SNAPSHOT_TIMEOUT_MS, OpenItemsSource, SnapshotRead, Sources, Unset,
};
use svc_ledger::controls::{
    self, ASOF_INVALID, Actor, BUILTIN_IMMUTABLE, CONTROL_NOT_FOUND, ControlError, ITEMS_MOVED,
    ITEMS_NOW_ONLY, MARGIN_UNSET, POLICY_UNSET, RAIL_SOURCE_UNSET, SOURCE_UNAVAILABLE,
    STATE_ILLEGAL,
};
use svc_ledger::db::Store;
use svc_ledger::door::{self, DoorConfig, LedgerDoor};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::{self, Posting};

const ACTOR: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REASON: &str = "set the reconciliation control";
const APPROVER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPLAY: &str = "11111111-1111-4111-8111-111111111111";
const NETTING: &str = "33333333-3333-4333-8333-333333333333";

// ── the kit ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// Why a call refused: its schema (`ZodError`, by its issues) or the control code.
#[derive(Debug)]
enum Fail {
    Zod(String),
    Control(ControlError),
}

/// `rejects.toMatchObject({ code })` / `toThrow(message)`: the code a refusal carries, else its message.
fn code(f: &Fail) -> String {
    match f {
        Fail::Control(ControlError::Code(c)) => c.clone(),
        Fail::Control(ControlError::Approval(Refused::Coded { code, .. })) => code.clone(),
        Fail::Control(e) => controls::message_of(e),
        Fail::Zod(m) => m.clone(),
    }
}

fn j(s: &str) -> Json {
    json::parse(s).unwrap_or_else(|e| panic!("{s}: {e:?}"))
}

/// A body with `$R` the reason and each named placeholder filled.
fn body(template: &str, fill: &[(&str, &str)]) -> Json {
    let mut s = template.replace("$R", REASON);
    for (k, v) in fill {
        s = s.replace(k, v);
    }
    j(&s)
}

fn parsed(name: &str, input: &Json) -> Result<Json, Fail> {
    match door::parse(name, Value::from_json(input)).unwrap() {
        Outcome::Ok(v) => Ok(v.to_json().unwrap()),
        Outcome::Issues(i) => Err(Fail::Zod(format!("{i:?}"))),
    }
}

fn actor() -> Actor {
    Actor {
        actor_id: ACTOR.to_owned(),
        request_id: Some("req-recon-1".to_owned()),
    }
}

struct Kit {
    db: TestDb,
    store: Store,
    approvals: Arc<Stub>,
    op: AtomicU32,
}

impl Kit {
    fn new() -> Option<Kit> {
        let db = TestDb::new()?;
        db.migrate(&FILES, false).unwrap();
        let store = db.store();
        Some(Kit {
            db,
            store,
            approvals: stub(Some(APPROVER), Some(true)),
            op: AtomicU32::new(0),
        })
    }

    /// A connection as the ledger's pool opens one: the `ledger` schema first.
    fn sql(&self) -> Client {
        let mut c = self.db.client();
        c.batch_execute("SET search_path = ledger, public").unwrap();
        c
    }

    fn next_op(&self) -> String {
        format!("op-recon-{}", self.op.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// `insertAccount(ownerId, createdAt = '2025-12-01T00:00:00Z')`.
    fn insert_account(&self, owner_id: &str) -> String {
        self.sql()
            .query_one(
                "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance, created_at)
                 VALUES ('user', $1, 'USDT', 'available', '', 0, '2025-12-01T00:00:00Z') RETURNING id::text",
                &[&owner_id],
            )
            .unwrap()
            .get(0)
    }

    fn define(&self, input: &Json) -> Result<Json, Fail> {
        let input = parsed("controlDefine", input)?;
        controls::define(&self.store, &actor(), &input).map_err(Fail::Control)
    }

    fn update_with(&self, input: &Json, approvals: &dyn Approvals) -> Result<Json, Fail> {
        let input = parsed("controlUpdate", input)?;
        controls::update(&self.store, &actor(), &input, approvals).map_err(Fail::Control)
    }

    fn update(&self, input: &Json) -> Result<Json, Fail> {
        self.update_with(input, &*self.approvals)
    }

    fn run_with(
        &self,
        approvals: &dyn Approvals,
        input: &Json,
        sources: &dyn Sources,
    ) -> Result<Json, Fail> {
        let input = parsed("controlRunInput", input)?;
        controls::run(&self.store, approvals, &actor(), &input, sources, None)
            .map_err(Fail::Control)
    }

    fn run(&self, input: &Json) -> Result<Json, Fail> {
        self.run_with(&*self.approvals, input, &Unset)
    }

    fn run_from(&self, input: &Json, sources: &dyn Sources) -> Result<Json, Fail> {
        self.run_with(&*self.approvals, input, sources)
    }

    fn run_due(&self, sources: &dyn Sources) {
        controls::run_due(&self.store, sources).unwrap();
    }

    fn list(&self) -> Json {
        controls::list(&self.store).unwrap()
    }

    fn list_runs(&self, input: &Json) -> Result<Json, Fail> {
        let input = parsed("controlRuns", input)?;
        controls::list_runs(&self.store, &input).map_err(Fail::Control)
    }

    fn run_count(&self, control_id: &str) -> i64 {
        self.sql()
            .query_one(
                "SELECT count(*)::int8 FROM reconciliation_control_runs WHERE control_id = $1::text::uuid",
                &[&control_id],
            )
            .unwrap()
            .get(0)
    }

    fn state(&self, control_id: &str) -> String {
        self.sql()
            .query_one(
                "SELECT state FROM reconciliation_controls WHERE id = $1::text::uuid",
                &[&control_id],
            )
            .unwrap()
            .get(0)
    }

    /// `engine.post(recipes.deposit({ userId, assetId, amount, rail, railRef }))`.
    fn fund(&self, user_id: &str, asset_id: &str, amount: &str, rail: &str, rail_ref: &str) {
        let request = j(&format!(
            r#"{{"idempotencyKey":"deposit:{rail}:{rail_ref}","module":"ledger","reason":"deposit.credited","meta":{{"rail":"{rail}","railRef":"{rail_ref}"}},"entries":[{{"account":{{"ownerType":"treasury","ownerId":"rail:{rail}","assetId":"{asset_id}","kind":"available"}},"direction":"credit","amount":"{amount}"}},{{"account":{{"ownerType":"user","ownerId":"{user_id}","assetId":"{asset_id}","kind":"available"}},"direction":"debit","amount":"{amount}"}}]}}"#
        ));
        let p = Posting::new(
            Arc::new(MemoryBus::default()),
            "svc-ledger".to_owned(),
            true,
            EngineOptions {
                conflict: Conflict::Refuse,
                clock_skew_bound_ms: None,
                clock_ms: system_ms,
            },
            false,
            None,
        );
        posting::post(&self.store, &p, None, "dual", &request).unwrap();
    }

    /// A user's available account of one asset.
    fn user_account(&self, user_id: &str, asset_id: &str) -> String {
        self.sql()
            .query_one(
                "SELECT id::text FROM accounts WHERE owner_type = 'user' AND owner_id = $1 AND asset_id = $2 AND kind = 'available'",
                &[&user_id, &asset_id],
            )
            .unwrap()
            .get(0)
    }

    /// The one-sided USDT fixture rows the margin case writes (two debits, no credit, the cached balance left at 0): the
    /// whole-book cases of the TypeScript file run with them in the book, so their USDT row is broken and each is judged
    /// on another asset's row alone.
    fn one_sided_usdt(&self, owner_id: &str, tx: (&str, &str)) -> String {
        let account = self.insert_account(owner_id);
        let mut c = self.sql();
        c.batch_execute(
            "ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_tx_must_balance",
        )
        .unwrap();
        c.execute(
            "INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
             VALUES ($1::text::uuid, 'recon-t1-' || $1, 'bank', 'bank.transfer.in', '{}'::jsonb, '2026-01-01T00:00:00Z', 'h1', NULL),
                    ($2::text::uuid, 'recon-t2-' || $2, 'bank', 'bank.transfer.in', '{}'::jsonb, '2026-01-02T00:00:00Z', 'h2', 'h1')",
            &[&tx.0, &tx.1],
        )
        .unwrap();
        c.execute(
            "INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
             VALUES ($1::text::uuid, $3::text::uuid, 'USDT', 'debit', 10, 10),
                    ($2::text::uuid, $3::text::uuid, 'USDT', 'debit', 15, 25)",
            &[&tx.0, &tx.1, &account],
        )
        .unwrap();
        c.batch_execute("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_tx_must_balance")
            .unwrap();
        account
    }
}

// ── reading answers ──────────────────────────────────────────────────────────────────────────────────────────────

fn at<'a>(v: &'a Json, path: &str) -> &'a Json {
    path.split('.').fold(v, |cur, k| {
        cur.get(k)
            .unwrap_or_else(|| panic!("{path}: no {k} in {}", v.compact()))
    })
}

fn st(v: &Json, path: &str) -> String {
    match at(v, path) {
        Json::String(s) => s.clone(),
        other => panic!("{path}: {}", other.compact()),
    }
}

fn arr<'a>(v: &'a Json, path: &str) -> &'a [Json] {
    match at(v, path) {
        Json::Array(a) => a,
        other => panic!("{path}: {}", other.compact()),
    }
}

fn strings(v: &Json, path: &str) -> Vec<String> {
    arr(v, path)
        .iter()
        .map(|x| match x {
            Json::String(s) => s.clone(),
            other => panic!("{}", other.compact()),
        })
        .collect()
}

/// Object keys in one order, so two values compare as `toEqual` does.
fn canon(v: &Json) -> Json {
    match v {
        Json::Object(o) => {
            let mut kv: Vec<(String, Json)> =
                o.iter().map(|(k, x)| (k.clone(), canon(x))).collect();
            kv.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(kv)
        }
        Json::Array(a) => Json::Array(a.iter().map(canon).collect()),
        other => other.clone(),
    }
}

/// `toEqual`.
fn assert_equal(actual: &Json, expected: &str) {
    assert_eq!(
        canon(actual).compact(),
        canon(&j(expected)).compact(),
        "toEqual"
    );
}

/// `toMatchObject`: every key the expected names, recursively; arrays element for element.
fn subset(expected: &Json, actual: &Json) -> bool {
    match (expected, actual) {
        (Json::Object(e), Json::Object(_)) => e
            .iter()
            .all(|(k, x)| actual.get(k).is_some_and(|a| subset(x, a))),
        (Json::Array(e), Json::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(x, y)| subset(x, y))
        }
        _ => expected == actual,
    }
}

fn assert_match(actual: &Json, expected: &str) {
    assert!(
        subset(&j(expected), actual),
        "toMatchObject: {} in {}",
        expected,
        actual.compact()
    );
}

fn asset<'a>(run: &'a Json, id: &str) -> &'a Json {
    arr(run, "assets")
        .iter()
        .find(|a| st(a, "assetId") == id)
        .unwrap_or_else(|| panic!("no {id} in {}", run.compact()))
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn pause(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

// ── a local HTTP server, as the TypeScript's Fastify one ─────────────────────────────────────────────────────────

struct Req {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: String,
}

impl Req {
    fn query(&self, k: &str) -> Option<String> {
        self.query
            .iter()
            .find(|(q, _)| q == k)
            .map(|(_, v)| v.clone())
    }
    fn header(&self, k: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(h, _)| h.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.clone())
    }
}

/// One request's query pairs.
type Query = Vec<(String, String)>;

/// What a route answers: its status, extra headers and JSON body.
type Reply = (u16, Vec<(String, String)>, String);
type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

fn ok(body: String) -> Reply {
    (200, Vec::new(), body)
}

/// Listen on a free local port; each connection answers one request. The base URL.
fn serve(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handler: Handler = Arc::new(handler);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let h = handler.clone();
            std::thread::spawn(move || answer(stream, &h));
        }
    });
    base
}

fn answer(mut stream: TcpStream, handler: &Handler) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).unwrap();
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, v)| v.parse::<usize>().unwrap());
    let mut raw = vec![0; length];
    reader.read_exact(&mut raw).unwrap();
    let url = url::Url::parse(&format!("http://local{target}")).unwrap();
    let req = Req {
        method,
        path: url.path().to_owned(),
        query: url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
        headers,
        body: String::from_utf8(raw).unwrap(),
    };
    let (status, extra, out) = handler(&req);
    let mut head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        out.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(out.as_bytes());
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

/// `reconciliationSourcesFrom(outsideSnapshotUrl, railStatementUrls, fetch, undefined, openItems)` on the real client.
fn http(book: Option<&str>, rails: &[(&str, &str)], items: Option<&[(&str, &str)]>) -> Http {
    Http {
        outside_snapshot_url: book.map(str::to_owned),
        rail_statement_urls: pairs(rails),
        fetch: Arc::new(service_kit::http::UreqFetch::new()),
        timeout_ms: OUTSIDE_SNAPSHOT_TIMEOUT_MS,
        open_items: items.map(|urls| OpenItemsSource {
            urls: pairs(urls),
            sign: Arc::new(|payload: &str, _url: &str| {
                Ok(vec![("x-test-signed".to_owned(), payload.to_owned())])
            }),
        }),
    }
}

/// One open item as svc-pay lists it.
#[derive(Clone)]
struct Listed {
    held: bool,
    id: String,
    asset_id: String,
    /// Signed: an uncovered reversal is negative.
    amount: String,
    seen: Option<String>,
}

fn held(id: &str, asset_id: &str, amount: &str) -> Listed {
    Listed {
        held: true,
        id: id.to_owned(),
        asset_id: asset_id.to_owned(),
        amount: amount.to_owned(),
        seen: None,
    }
}

fn unfunded(id: &str, asset_id: &str, amount: &str) -> Listed {
    Listed {
        held: false,
        ..held(id, asset_id, amount)
    }
}

/// svc-pay's open-items page for this offset and limit: the items, their total and per-asset sums.
fn items_page(listed: &[Listed], user_id: &str, tx_prefix: &str, ask: &Json) -> String {
    let n = |k: &str| match ask.get(k) {
        Some(Json::Number(v)) => {
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a page number"
            )]
            let whole = *v as usize;
            whole
        }
        _ => panic!("no {k}"),
    };
    let (offset, limit) = (n("offset"), n("limit"));
    let all: Vec<String> = listed
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let (kind, status, reason) = if item.held {
                ("held", "held_travel_rule", "null")
            } else {
                ("reversal_unfunded", "needs_review", "\"reversal_unfunded\"")
            };
            format!(
                r#"{{"depositId":"{}","kind":"{kind}","userId":"{user_id}","assetId":"{}","networkId":"ethereum","txHash":"{tx_prefix}{i}","outputIndex":0,"amount":"{}","signedAmount":"{}","status":"{status}","reason":{reason},"detectedAt":"{}"}}"#,
                item.id,
                item.asset_id,
                item.amount.replace('-', ""),
                item.amount,
                item.seen.as_deref().unwrap_or("2026-01-01T00:00:00.000Z"),
            )
        })
        .collect();
    let mut assets: Vec<&str> = Vec::new();
    for i in listed {
        if !assets.contains(&i.asset_id.as_str()) {
            assets.push(&i.asset_id);
        }
    }
    let sums: Vec<String> = assets
        .iter()
        .map(|a| {
            let of = |h: bool| listed.iter().filter(move |i| i.asset_id == *a && i.held == h);
            let add = |h: bool| of(h).map(|i| amt(&i.amount.replace('-', ""))).sum::<Amount>();
            format!(
                r#"{{"networkId":"ethereum","assetId":"{a}","held":"{}","heldCount":{},"reversalUnfunded":"{}","reversalUnfundedCount":{},"net":"{}"}}"#,
                format_amount(add(true)),
                of(true).count(),
                format_amount(add(false)),
                of(false).count(),
                format_amount(add(true) - add(false)),
            )
        })
        .collect();
    let to = (offset + limit).min(all.len());
    let from = offset.min(to);
    format!(
        r#"{{"items":[{}],"total":{},"sums":[{}]}}"#,
        all[from..to].join(","),
        all.len(),
        sums.join(",")
    )
}

// ── approvals ────────────────────────────────────────────────────────────────────────────────────────────────────

/// What one consume was asked, every field.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Asked {
    approval_id: String,
    operation_id: String,
    payload_hash: String,
    target_service: String,
    target_id: String,
    expected_version: String,
    replay: Option<(String, Option<String>)>,
}

fn asked_of(input: &ConsumeInput<'_>) -> Asked {
    Asked {
        approval_id: input.approval_id.to_owned(),
        operation_id: input.operation_id.to_owned(),
        payload_hash: input.payload_hash.to_owned(),
        target_service: input.target_service.to_owned(),
        target_id: input.target_id.to_owned(),
        expected_version: input.expected_version.to_owned(),
        replay: input.replay.map(|r| {
            (
                r.request_id.to_owned(),
                r.consumer_principal_id.map(str::to_owned),
            )
        }),
    }
}

/// Identity replaying a consume this operation already made, attested by both founders or not.
struct ReplayingIdentity {
    attested: bool,
    seen: Mutex<Option<String>>,
}

impl Approvals for ReplayingIdentity {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        *self.seen.lock().unwrap() = input.replay.map(|r| r.request_id.to_owned());
        Ok(Consumed {
            action_type: "ledger.reconciliation_control.run".to_owned(),
            target_service: input.target_service.to_owned(),
            target_id: input.target_id.to_owned(),
            status: "CONSUMED".to_owned(),
            requester_id: "founder-a".to_owned(),
            approver_id: Some("founder-b".to_owned()),
            approver_is_founder: self.attested.then_some(true),
            requester_is_founder: self.attested.then_some(true),
        })
    }
}

/// Identity that refuses by throwing.
struct Refusing;

impl Approvals for Refusing {
    fn consume(&self, _: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        Err(Refused::Thrown("identity refused".to_owned()))
    }
}

/// The stub, recording what each consume was asked.
struct Recording {
    inner: Arc<Stub>,
    seen: Mutex<Vec<Asked>>,
}

impl Approvals for Recording {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.seen.lock().unwrap().push(asked_of(input));
        self.inner.consume(input)
    }
}

/// The stub, after a pause of the control commits (while identity answers).
struct Pausing {
    url: String,
    control_id: String,
    inner: Arc<Stub>,
}

impl Approvals for Pausing {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let mut c = Client::connect(&self.url, NoTls).unwrap();
        c.execute(
            "UPDATE ledger.reconciliation_controls SET state = 'paused', version = version + 1 WHERE id = $1::text::uuid",
            &[&self.control_id],
        )
        .unwrap();
        self.inner.consume(input)
    }
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn refuses_activation_with_a_blank_tolerance_and_leaves_the_control_draft() {
    let Some(k) = Kit::new() else { return };
    let before = arr(&k.list(), "controls").len();
    // Define with activate stores nothing when the policy is incomplete: no orphan draft on a retry.
    let refused = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},"reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap_err();
    assert_eq!(code(&refused), POLICY_UNSET);
    assert_eq!(arr(&k.list(), "controls").len(), before);
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let refused = k
        .update(&body(
            r#"{"controlId":"$ID","reason":"$R","activate":true}"#,
            &[("$ID", &id)],
        ))
        .unwrap_err();
    assert_eq!(code(&refused), POLICY_UNSET);
    let listed = k.list();
    let draft = arr(&listed, "controls")
        .iter()
        .find(|c| st(c, "id") == id)
        .unwrap();
    assert_eq!(st(draft, "state"), "draft");
    assert_equal(at(draft, "tolerance"), r#"{"status":"unset"}"#);
    let audit: Vec<(String, String, String)> = k
        .sql()
        .query(
            "SELECT actor_id, reason, action FROM reconciliation_control_audit WHERE control_id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        audit,
        [(ACTOR.to_owned(), REASON.to_owned(), "define".to_owned())]
    );
}

#[test]
fn keeps_the_three_built_in_controls_when_a_delete_is_attempted() {
    let Some(k) = Kit::new() else { return };
    let deleted = k
        .sql()
        .execute(
            "DELETE FROM reconciliation_controls WHERE builtin_key = 'replay'",
            &[],
        )
        .unwrap_err();
    assert!(
        format!("{deleted:?}").contains("cannot be removed"),
        "{deleted:?}"
    );
    let listed = k.list();
    let keys: Vec<Json> = arr(&listed, "controls")
        .iter()
        .filter(|c| at(c, "builtin") == &Json::Bool(true))
        .map(|c| at(c, "checkKind").clone())
        .collect();
    assert_equal(
        &Json::Array(keys),
        r#"[{"status":"set","value":"chain"},{"status":"set","value":"netting"},{"status":"set","value":"replay"}]"#,
    );
    let refused = k
        .update(&body(
            r#"{"controlId":"$ID","reason":"$R","explanation":"remove the built-in"}"#,
            &[("$ID", REPLAY)],
        ))
        .unwrap_err();
    assert_eq!(code(&refused), BUILTIN_IMMUTABLE);
}

#[test]
fn includes_a_new_matching_account_on_the_next_run() {
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","ownerIdPrefix":"abcdeaaa-1111-4111-8111-"},
                "schedule":{"cadence":"weekly","isoWeekday":1,"hour":0,"minute":0},"severity":"warning",
                "tolerance":{"default":"0"},"threshold":{"bound":"min","byAsset":{"USDT":"0"}},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let active = k
        .update(&body(
            r#"{"controlId":"$ID","reason":"$R","activate":true}"#,
            &[("$ID", &id)],
        ))
        .unwrap();
    assert_eq!(st(&active, "state"), "active");
    assert_match(
        at(&active, "schedule"),
        r#"{"status":"set","period":"iso_week"}"#,
    );
    let first = k.insert_account("abcdeaaa-1111-4111-8111-000000000001");
    let run1 = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-1","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert_eq!(strings(&run1, "accounts"), std::slice::from_ref(&first));
    assert_eq!(st(&run1, "status"), "PASS");
    let second = k.insert_account("abcdeaaa-1111-4111-8111-000000000002");
    let run2 = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-2","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
        .unwrap();
    let mut both = vec![first, second];
    both.sort();
    assert_eq!(strings(&run2, "accounts"), both);
}

/// A source whose whole-book read first looks at the run row the control has stored.
struct LooksFirst {
    url: String,
    control_id: String,
    seen: Mutex<bool>,
}

impl Sources for LooksFirst {
    fn outside_balance(&self, _: i64) -> SnapshotRead {
        let mut c = Client::connect(&self.url, NoTls).unwrap();
        let rows = c
            .query(
                "SELECT status, sources->'ledger'->>'asOf' FROM ledger.reconciliation_control_runs WHERE control_id = $1::text::uuid",
                &[&self.control_id],
            )
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<_, String>(0), "started");
        let as_of: String = rows[0].get(1);
        assert!(
            as_of.len() > 5
                && as_of[..4].chars().all(|c| c.is_ascii_digit())
                && &as_of[4..5] == "-",
            "{as_of}"
        );
        *self.seen.lock().unwrap() = true;
        SnapshotRead::Unset
    }
    fn rail_statement(&self, _: i64, _: &str) -> SnapshotRead {
        SnapshotRead::Unset
    }
    fn parity(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Unset
    }
}

#[test]
fn stores_the_result_row_before_reading_and_shows_an_absent_outside_balance_as_unset() {
    let Some(k) = Kit::new() else { return };
    // Earlier TypeScript cases leave USDT accounts in the book; one stands for them, so the set is not empty.
    k.insert_account("abcdeaaa-0000-4000-8000-000000000001");
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let sources = LooksFirst {
        url: k.db.url.clone(),
        control_id: id.clone(),
        seen: Mutex::new(false),
    };
    let run = k
        .run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-3","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            &sources,
        )
        .unwrap();
    assert!(*sources.seen.lock().unwrap());
    assert_eq!(st(&run, "outsideSide"), "unset");
    assert_eq!(st(&run, "status"), "UNSET");
    assert!(
        arr(&run, "assets")
            .iter()
            .all(|a| st(a, "expected") == "unset" && st(a, "difference") == "unset")
    );
}

#[test]
fn a_past_read_finds_the_set_with_one_hashed_lookup_of_posted_entries_never_a_walk_of_every_account_8044()
 {
    let Some(k) = Kit::new() else { return };
    // Issue #8044: on a young database with no statistics, a per-account EXISTS was planned as a correlated subplan that,
    // for a readAt before every posting, read every entry of every account in the set. The posted side must be one
    // uncorrelated lookup that Postgres hashes once. Temporary tables of the same shape shadow the real ones on this
    // connection (pg_temp is searched first) and are never analysed, so the planner sees exactly that young database.
    let mut c = k.sql();
    let mut tx = c.transaction().unwrap();
    for table in ["accounts", "ledger_tx", "ledger_entries"] {
        tx.batch_execute(&format!(
            "CREATE TEMP TABLE {table} (LIKE {table} INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP"
        ))
        .unwrap();
    }
    tx.batch_execute(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind)
         SELECT 'user', gen_random_uuid()::text, 'USDT', 'available' FROM generate_series(1, 3000);
         INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
         SELECT 'recon-8044-' || g, 'bank', 'bank.transfer.in', 'h' FROM generate_series(1, 30000) g;
         INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         SELECT t.id, a.id, 'USDT', 'debit', 1, 1
           FROM (SELECT id, row_number() OVER () AS n FROM ledger_tx) t
           JOIN (SELECT id, row_number() OVER () AS n FROM accounts) a ON a.n = 1 + (t.n % 3000);",
    )
    .unwrap();
    let read_at = "2025-06-01T00:00:00.000Z";
    let plan: Vec<String> = tx
        .query(
            &format!(
                "EXPLAIN SELECT id, asset_id FROM accounts WHERE {} AND asset_id = 'USDT'",
                controls::existed_at(1)
            ),
            &[&read_at],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    tx.rollback().unwrap();
    let text = plan.join("\n");
    // The filter names the subplan it evaluates: `(hashed SubPlan 1)` is built once, a bare `(SubPlan 1)` runs per row.
    let subplans: Vec<usize> = text.match_indices("SubPlan ").map(|(i, _)| i).collect();
    let closed = |i: usize| {
        let rest = &text[i + "SubPlan ".len()..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && rest[digits..].starts_with(')')
    };
    assert!(
        subplans
            .iter()
            .any(|&i| closed(i) && text[..i].ends_with("(hashed ")),
        "{text}"
    );
    assert!(
        !subplans
            .iter()
            .any(|&i| closed(i) && !text[..i].ends_with("hashed ")),
        "{text}"
    );
}

#[test]
fn reads_a_past_instant_minus_the_margin_accepts_0_and_refuses_a_blank_margin_or_a_future_instant()
{
    let Some(k) = Kit::new() else { return };
    let account = k.one_sided_usdt(
        "abcdeaaa-1111-4111-8111-000000000010",
        (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
        ),
    );
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"explicit","accountIds":["$A"]},
                "schedule":{"cadence":"hourly","minute":0},"severity":"critical","tolerance":{"default":"0"},
                "threshold":{"bound":"max","byAsset":{"USDT":"1000"}},"reason":"$R","activate":true}"#,
            &[("$A", &account)],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let input = |extra: &str, approval: &str| {
        body(
            &format!(
                r#"{{"controlId":"$ID","reason":"$R","asOf":"2026-01-02T00:00:10.000Z"{extra},"approvalId":"{approval}","operationId":"$OP"}}"#
            ),
            &[("$ID", &id), ("$OP", &k.next_op())],
        )
    };
    let refused = k.run(&input("", "appr-4")).unwrap_err();
    assert!(
        matches!(refused, Fail::Control(ControlError::Code(_))),
        "{refused:?}"
    );
    assert_eq!(
        code(&k.run(&input("", "appr-4")).unwrap_err()),
        MARGIN_UNSET
    );
    let exact = k.run(&input(r#","margin":"0""#, "appr-5")).unwrap();
    assert_eq!(st(asset(&exact, "USDT"), "observed"), "25");
    let margined = k.run(&input(r#","margin":"20""#, "appr-6")).unwrap();
    assert_eq!(st(&margined, "readAt"), "2026-01-01T23:59:50.000Z");
    assert_eq!(st(asset(&margined, "USDT"), "observed"), "10");
    let future = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","asOf":"2999-01-01T00:00:00.000Z","margin":"0","approvalId":"appr-7","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
        .unwrap_err();
    assert_eq!(code(&future), ASOF_INVALID);
}

fn door(k: &Kit, sources: Arc<dyn Sources>) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        reconciliation_sources: sources,
        ..door_config(
            &k.db,
            Arc::new(MemoryBus::default()),
            Box::new(Shared(k.approvals.clone())),
        )
    })
    .unwrap()
}

#[test]
fn lists_controls_for_compliance_and_refuses_a_treasury_define_without_a_second_factor() {
    let Some(k) = Kit::new() else { return };
    let d = door(&k, Arc::new(Unset));
    let (status, listed) = call(
        &d,
        "GET",
        "/operator/reconciliation/controls",
        Some(bearer(&["admin:compliance"], false)),
        "",
    );
    assert_eq!(status, 200);
    assert_eq!(
        arr(&listed, "controls")
            .iter()
            .filter(|c| at(c, "builtin") == &Json::Bool(true))
            .count(),
        3
    );
    let payload = body(
        r#"{"template":"source_parity","accountSet":{"mode":"query","assetId":"USDT"},"reason":"$R"}"#,
        &[],
    )
    .compact();
    let (status, refused) = call(
        &d,
        "POST",
        "/operator/reconciliation/controls",
        Some(bearer(&["admin:treasury"], false)),
        &payload,
    );
    // tRPC's UNAUTHORIZED: the door's 401 with the second factor's code.
    assert_eq!((status, door_code(&refused)), (401, Some("mfa.required")));
    assert_eq!(arr(&k.list(), "controls").len(), 3);
}

/// `replayControl()`.
fn replay_control(k: &Kit) -> String {
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"margin":"0","reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    st(&defined, "id")
}

fn stored_statuses(k: &Kit, operation_id: &str) -> Vec<String> {
    k.sql()
        .query(
            "SELECT status FROM reconciliation_control_runs WHERE operation_id = $1",
            &[&operation_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

#[test]
fn inserts_the_run_when_identity_replays_an_attested_consume_of_this_operation_id() {
    let Some(k) = Kit::new() else { return };
    let id = replay_control(&k);
    let op = k.next_op();
    let identity = ReplayingIdentity {
        attested: true,
        seen: Mutex::new(None),
    };
    let run = k
        .run_with(
            &identity,
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-replay","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &op)],
            ),
            &Unset,
        )
        .unwrap();
    assert_eq!(identity.seen.lock().unwrap().as_deref(), Some(op.as_str()));
    assert_ne!(st(&run, "status"), "started");
    assert_eq!(stored_statuses(&k, &op), [st(&run, "status")]);
}

#[test]
fn refuses_a_replayed_consume_without_the_founder_attestation_and_stores_no_run() {
    let Some(k) = Kit::new() else { return };
    let id = replay_control(&k);
    let op = k.next_op();
    let identity = ReplayingIdentity {
        attested: false,
        seen: Mutex::new(None),
    };
    let refused = k
        .run_with(
            &identity,
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-replay-unattested","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &op)],
            ),
            &Unset,
        )
        .unwrap_err();
    assert_eq!(code(&refused), "action_approval.not_founders");
    assert!(stored_statuses(&k, &op).is_empty());
}

/// A run's row put back to `started`, and the control's set made unreadable, so the resume throws in its accounts phase.
fn restart_unreadable(k: &Kit, run_id: &str, control_id: &str) {
    let mut c = k.sql();
    c.execute(
        "UPDATE reconciliation_control_runs SET status = 'started', phase = '', error_code = '', finished_at = NULL
          WHERE id = $1::text::uuid",
        &[&run_id],
    )
    .unwrap();
    c.execute(
        "UPDATE reconciliation_controls SET account_set = '{\"mode\":\"nope\"}'::jsonb WHERE id = $1::text::uuid",
        &[&control_id],
    )
    .unwrap();
}

#[test]
fn finishes_a_started_run_as_error_when_evaluate_throws_and_a_later_retry_stays_on_that_row() {
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"hourly","minute":0},"severity":"warning","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"margin":"0","reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let op = k.next_op();
    let run = |approval: &str| {
        k.run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"$AP","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &op), ("$AP", approval)],
        ))
        .unwrap()
    };
    let first = run("appr-started");
    assert_ne!(st(&first, "status"), "started");
    restart_unreadable(&k, &st(&first, "id"), &id);
    let resumed = run("appr-started-again");
    assert_eq!(st(&resumed, "id"), st(&first, "id"));
    assert_eq!(st(&resumed, "status"), "ERROR");
    assert_equal(
        at(&resumed, "phase"),
        r#"{"status":"set","value":"accounts"}"#,
    );
    assert_equal(
        at(&resumed, "errorCode"),
        &format!(r#"{{"status":"set","value":"{SOURCE_UNAVAILABLE}"}}"#),
    );
    let again = run("appr-started-third");
    assert_match(
        &again,
        &format!(r#"{{"id":"{}","status":"ERROR"}}"#, st(&first, "id")),
    );
}

#[test]
fn resumes_a_started_schedule_row_and_skips_a_terminal_one() {
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"hourly","minute":0},"severity":"info","tolerance":{"default":"0"},
                "threshold":{"bound":"max","byAsset":{"USDT":"1000"}},"margin":"0","reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    k.run_due(&Unset);
    // The current hour and the hour before it (caught up, so a due instant no tick landed after still runs).
    let opened: Vec<(String, String, String, i64)> = k
        .sql()
        .query(
            "SELECT id::text, status, finished_at::text, floor(extract(epoch FROM period_start) * 1000)::int8
               FROM reconciliation_control_runs WHERE control_id = $1::text::uuid ORDER BY period_start DESC",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert_eq!(opened.len(), 2);
    assert_eq!(opened[0].3 - opened[1].3, 3_600_000);
    assert!(opened.iter().all(|r| r.1 != "started"));
    k.run_due(&Unset);
    let skipped: (String, String) = {
        let r = k
            .sql()
            .query_one(
                "SELECT status, finished_at::text FROM reconciliation_control_runs WHERE id = $1::text::uuid",
                &[&opened[0].0],
            )
            .unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!(skipped, (opened[0].1.clone(), opened[0].2.clone()));
    restart_unreadable(&k, &opened[0].0, &id);
    k.run_due(&Unset);
    let resumed: (String, String, String) = {
        let r = k
            .sql()
            .query_one(
                "SELECT status, phase, error_code FROM reconciliation_control_runs WHERE id = $1::text::uuid",
                &[&opened[0].0],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2))
    };
    assert_eq!(
        resumed,
        (
            "ERROR".to_owned(),
            "accounts".to_owned(),
            SOURCE_UNAVAILABLE.to_owned()
        )
    );
}

#[test]
fn pauses_resumes_and_retires_a_control_paused_and_retired_run_nothing_retired_is_final() {
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","ownerIdPrefix":"abcdeaaa-3333-4333-8333-"},
                "schedule":{"cadence":"hourly","minute":0},"severity":"warning","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let run = || {
        k.run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-life","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
    };
    let move_to = |lifecycle: &str| {
        k.update(&body(
            r#"{"controlId":"$ID","reason":"$R","lifecycle":"$L","approvalId":"appr-move","operationId":"$OP"}"#,
            &[("$ID", &id), ("$L", lifecycle), ("$OP", &k.next_op())],
        ))
    };
    let edit = |fields: &str| {
        k.update(&body(
            &format!(r#"{{"controlId":"$ID","reason":"$R",{fields}}}"#),
            &[("$ID", &id)],
        ))
    };

    // A draft cannot be paused or resumed; a lifecycle move travels alone.
    assert_eq!(code(&move_to("pause").unwrap_err()), STATE_ILLEGAL);
    assert_eq!(code(&move_to("resume").unwrap_err()), STATE_ILLEGAL);
    let alone = k
        .update(&body(
            r#"{"controlId":"$ID","reason":"$R","lifecycle":"pause","activate":true,"approvalId":"appr-move","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
        .unwrap_err();
    assert!(code(&alone).contains(STATE_ILLEGAL), "{alone:?}");
    edit(r#""activate":true"#).unwrap();

    let paused = move_to("pause").unwrap();
    assert_eq!(st(&paused, "state"), "paused");
    assert_eq!(code(&run().unwrap_err()), STATE_ILLEGAL);
    k.run_due(&Unset);
    assert_eq!(k.run_count(&id), 0);
    // A paused control takes edits and stays paused; it is not activated by an update.
    let edited = edit(r#""severity":"critical""#).unwrap();
    assert_match(
        &edited,
        r#"{"state":"paused","severity":{"status":"set","value":"critical"}}"#,
    );
    assert_eq!(
        code(&edit(r#""activate":true"#).unwrap_err()),
        STATE_ILLEGAL
    );
    assert_eq!(code(&move_to("pause").unwrap_err()), STATE_ILLEGAL);

    let resumed = move_to("resume").unwrap();
    assert_eq!(st(&resumed, "state"), "active");
    // The hours that fell due while it was paused are not caught up on resume.
    k.run_due(&Unset);
    assert_eq!(k.run_count(&id), 0);
    // A resumed control runs. Its set holds no USDT account, so the ledger side is missing: FAIL by name, never a PASS
    // over a zero (OWNER 288).
    let resumed_run = run().unwrap();
    assert_eq!(st(&resumed_run, "status"), "FAIL");
    assert_match(
        at(&resumed_run, "assets"),
        r#"[{"assetId":"USDT","observed":"unset","missing":"ledger"}]"#,
    );
    assert_eq!(k.run_count(&id), 1);

    let retired = move_to("retire").unwrap();
    assert_eq!(st(&retired, "state"), "retired");
    assert_eq!(code(&run().unwrap_err()), STATE_ILLEGAL);
    for lifecycle in ["pause", "resume", "retire"] {
        assert_eq!(code(&move_to(lifecycle).unwrap_err()), STATE_ILLEGAL);
    }
    assert_eq!(
        code(&edit(r#""explanation":"revive""#).unwrap_err()),
        STATE_ILLEGAL
    );
    k.run_due(&Unset);
    // Retired keeps its row, its one run and its history.
    assert_eq!(k.run_count(&id), 1);
    assert_eq!(k.state(&id), "retired");
    let audit: Vec<(String, String, String)> = k
        .sql()
        .query(
            "SELECT detail->>'lifecycle', detail->>'from', detail->>'state' FROM reconciliation_control_audit
              WHERE control_id = $1::text::uuid AND detail ? 'lifecycle' ORDER BY id",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    let own = |a: &str, b: &str, c: &str| (a.to_owned(), b.to_owned(), c.to_owned());
    assert_eq!(
        audit,
        [
            own("pause", "active", "paused"),
            own("resume", "paused", "active"),
            own("retire", "active", "retired"),
        ]
    );
}

#[test]
fn refuses_a_lifecycle_move_on_a_built_in_control_and_retires_a_draft() {
    let Some(k) = Kit::new() else { return };
    let builtin: String = k
        .sql()
        .query_one(
            "SELECT id::text FROM reconciliation_controls WHERE builtin LIMIT 1",
            &[],
        )
        .unwrap()
        .get(0);
    let move_to = |id: &str, lifecycle: &str| {
        k.update(&body(
            r#"{"controlId":"$ID","reason":"$R","lifecycle":"$L","approvalId":"appr-move","operationId":"$OP"}"#,
            &[("$ID", id), ("$L", lifecycle), ("$OP", &k.next_op())],
        ))
    };
    assert_eq!(
        code(&move_to(&builtin, "pause").unwrap_err()),
        BUILTIN_IMMUTABLE
    );
    let draft = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let retired = move_to(&st(&draft, "id"), "retire").unwrap();
    assert_eq!(st(&retired, "state"), "retired");
}

#[test]
fn binds_a_lifecycle_move_to_two_founders_the_control_the_move_and_the_reason_at_the_version_read()
{
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","ownerIdPrefix":"abcdeaaa-4444-4444-8444-"},
                "schedule":{"cadence":"hourly","minute":0},"severity":"warning","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let active = k
        .update(&body(
            r#"{"controlId":"$ID","reason":"$R","activate":true}"#,
            &[("$ID", &id)],
        ))
        .unwrap();
    // Without the approval ids the move is refused before it reads anything.
    assert!(
        parsed(
            "controlUpdate",
            &body(
                r#"{"controlId":"$ID","reason":"$R","lifecycle":"pause"}"#,
                &[("$ID", &id)]
            )
        )
        .is_err()
    );
    assert!(
        parsed(
            "controlUpdate",
            &body(
                r#"{"controlId":"$ID","reason":"$R","severity":"info","approvalId":"a","operationId":"o"}"#,
                &[("$ID", &id)]
            )
        )
        .is_err()
    );
    let pause = |approval: &str, op: &str, approvals: &dyn Approvals| {
        k.update_with(
            &body(
                r#"{"controlId":"$ID","reason":"$R","lifecycle":"pause","approvalId":"$AP","operationId":"$OP"}"#,
                &[("$ID", &id), ("$AP", approval), ("$OP", op)],
            ),
            approvals,
        )
    };
    // An identity that refuses leaves the control as it was.
    let refused = pause("appr-no", &k.next_op(), &Refusing).unwrap_err();
    assert_eq!(code(&refused), "identity refused");
    assert_eq!(k.state(&id), "active");
    let recording = Recording {
        inner: k.approvals.clone(),
        seen: Mutex::new(Vec::new()),
    };
    let paused = pause("appr-yes", "op-life-yes", &recording).unwrap();
    assert_eq!(st(&paused, "state"), "paused");
    let payload = format!(
        r#"{{"actionType":"ledger.reconciliation_control.lifecycle","controlId":"{id}","lifecycle":"pause","reason":"{REASON}"}}"#
    );
    let hash: String = Sha256::digest(payload.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let version = match at(&active, "version") {
        Json::Number(n) => format!("{n}"),
        other => panic!("{}", other.compact()),
    };
    assert_eq!(
        *recording.seen.lock().unwrap(),
        [Asked {
            approval_id: "appr-yes".to_owned(),
            operation_id: "op-life-yes".to_owned(),
            payload_hash: format!("sha256:{hash}"),
            target_service: "svc-ledger".to_owned(),
            target_id: "posting_reconciliation_control.lifecycle".to_owned(),
            expected_version: version,
            replay: None,
        }]
    );
    // An illegal move is refused before identity is asked, so it spends no approval.
    let illegal = pause("appr-again", &k.next_op(), &recording).unwrap_err();
    assert_eq!(code(&illegal), STATE_ILLEGAL);
    assert_eq!(recording.seen.lock().unwrap().len(), 1);
}

#[test]
fn opens_no_run_on_a_control_paused_after_it_was_read_and_still_finishes_a_run_that_had_opened() {
    let Some(k) = Kit::new() else { return };
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"query","ownerIdPrefix":"abcdeaaa-5555-4555-8555-"},
                "schedule":{"cadence":"hourly","minute":0},"severity":"warning","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"reason":"$R"}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    k.update(&body(
        r#"{"controlId":"$ID","reason":"$R","activate":true}"#,
        &[("$ID", &id)],
    ))
    .unwrap();
    // The pause commits while the run is between its read and its insert (here: while identity answers).
    let pausing = Pausing {
        url: k.db.url.clone(),
        control_id: id.clone(),
        inner: k.approvals.clone(),
    };
    let refused = k
        .run_with(
            &pausing,
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-race","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            &Unset,
        )
        .unwrap_err();
    assert_eq!(code(&refused), STATE_ILLEGAL);
    assert_eq!(k.run_count(&id), 0);

    // A run that opened before the pause is answered on retry, not stranded.
    let set_state = |state: &str| {
        k.sql()
            .execute(
                "UPDATE reconciliation_controls SET state = $2, version = version + 1 WHERE id = $1::text::uuid",
                &[&id, &state],
            )
            .unwrap();
    };
    set_state("active");
    let op = k.next_op();
    let run = || {
        k.run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-done","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &op)],
        ))
        .unwrap()
    };
    let first = run();
    set_state("paused");
    let again = run();
    assert_eq!(canon(&again), canon(&first));
    k.sql()
        .execute(
            "UPDATE reconciliation_control_runs SET status = 'started' WHERE id = $1::text::uuid",
            &[&st(&first, "id")],
        )
        .unwrap();
    let resumed = run();
    assert_eq!(st(&resumed, "id"), st(&first, "id"));
    assert_ne!(st(&resumed, "status"), "started");
}

#[test]
fn catches_a_cached_balance_the_entries_do_not_explain_on_a_run_now() {
    let Some(k) = Kit::new() else { return };
    // The whole book of the TypeScript file holds the margin case's one-sided rows too; they are planted here.
    k.one_sided_usdt(
        "abcdeaaa-1111-4111-8111-000000000010",
        (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
        ),
    );
    let drifted = k.insert_account("abcdeaaa-2222-4222-8222-000000000001");
    k.sql()
        .execute(
            "UPDATE accounts SET balance = 5 WHERE id = $1::text::uuid",
            &[&drifted],
        )
        .unwrap();
    let run = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-drift","operationId":"$OP"}"#,
            &[("$ID", REPLAY), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert_eq!(st(&run, "status"), "FAIL");
    // The row observes the summed size of each USDT account's drift against 0: this account's 5 on top of the one-sided
    // fixture rows.
    assert_match(at(&run, "assets"), r#"[{"assetId":"USDT","expected":"0"}]"#);
    assert!(amt(&st(&arr(&run, "assets")[0], "observed")) >= amt("5"));
}

#[test]
fn leaves_an_account_created_and_funded_after_read_at_out_of_every_side_and_its_counter_leg_at_read_at_the_total_stays_0()
 {
    let Some(k) = Kit::new() else { return };
    // Whole-book controls: an earlier TypeScript case leaves one-sided USDT rows, planted here, so each run is judged on
    // its BTC row alone.
    k.one_sided_usdt(
        "abcdeaaa-1111-4111-8111-000000000010",
        (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
        ),
    );
    let tick = || pause(5);
    let fund = |user: &str, rail_ref: &str| k.fund(user, "BTC", "7", "test", rail_ref);
    // The first deposit makes the rail boundary account, so the counter-leg exists before read_at.
    fund("abcdeaaa-4444-4444-8444-000000000001", "recon-snap-1");
    let zero =
        r#"{"assetId":"BTC","observed":"0","expected":"0","difference":"0","tolerance":"0"}"#;
    let open = |control: &str, approval: &str| {
        let op = k.next_op();
        let run = k
            .run(&body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"$AP","operationId":"$OP"}"#,
                &[("$ID", control), ("$AP", approval), ("$OP", &op)],
            ))
            .unwrap();
        assert_equal(asset(&run, "BTC"), zero);
        (run, op)
    };
    let netting = open(NETTING, "appr-snap-1");
    let replay = open(REPLAY, "appr-snap-2");
    // Hold both runs at one read_at, on a millisecond as the driver reads it, with the deposits strictly either side. The
    // instant is read once: clock_timestamp() in the UPDATE itself is taken per row, so the two runs could land a
    // millisecond apart and the netting run be judged against the replay run's instant (#6796).
    tick();
    let read_at = read_database_now(&k.store).unwrap();
    let read_at_iso = Instant(read_at).iso();
    let stamped: Vec<i64> = k
        .sql()
        .query(
            "UPDATE reconciliation_control_runs
                SET status = 'started', phase = '', error_code = '', finished_at = NULL, read_at = $1::text::timestamptz
              WHERE id = ANY($2::text[]::uuid[])
             RETURNING floor(extract(epoch FROM read_at) * 1000)::int8",
            &[&read_at_iso, &vec![st(&netting.0, "id"), st(&replay.0, "id")]],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(stamped, [read_at, read_at]);
    tick();
    fund("abcdeaaa-4444-4444-8444-000000000002", "recon-snap-2");
    let legs: Vec<(String, i64, String)> = k
        .sql()
        .query(
            "SELECT a.id::text, floor(extract(epoch FROM a.created_at) * 1000)::int8, a.owner_id
               FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id JOIN accounts a ON a.id = e.account_id
              WHERE t.idempotency_key LIKE '%recon-snap-2%'",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(legs.len(), 2);
    let fresh = legs
        .iter()
        .find(|l| l.2 == "abcdeaaa-4444-4444-8444-000000000002")
        .unwrap();
    let boundary = legs.iter().find(|l| l.0 != fresh.0).unwrap();
    // `created_at` keeps microseconds; the TypeScript reads it as a millisecond `Date`, as the floor does here.
    assert!(fresh.1 > read_at, "{} after {read_at}", fresh.1);
    assert!(boundary.1 < read_at, "{} before {read_at}", boundary.1);

    let again = |control: &str, approval: &str, op: &str| {
        k.run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"$AP","operationId":"$OP"}"#,
            &[("$ID", control), ("$AP", approval), ("$OP", op)],
        ))
        .unwrap()
    };
    // The run resumes after the deposit, at the current instant: the fresh account is in no side, the boundary is counted
    // at read_at, and the BTC total is exactly 0.
    let resumed = again(NETTING, "appr-snap-3", &netting.1);
    assert_eq!(st(&resumed, "id"), st(&netting.0, "id"));
    assert_ne!(st(&resumed, "status"), "started");
    assert_equal(asset(&resumed, "BTC"), zero);
    assert!(strings(&resumed, "accounts").contains(&boundary.0));
    assert!(!strings(&resumed, "accounts").contains(&fresh.0));
    assert_eq!(st(&resumed, "sources.ledger.asOf"), read_at_iso);

    // The replay reports balance_after against the entries at read_at, and checks the cached column against the entries
    // on its snapshot: no drift from a deposit that landed after read_at.
    let replayed = again(REPLAY, "appr-snap-4", &replay.1);
    assert_eq!(st(&replayed, "id"), st(&replay.0, "id"));
    assert_ne!(st(&replayed, "status"), "started");
    assert_equal(asset(&replayed, "BTC"), zero);
    assert!(!strings(&replayed, "accounts").contains(&fresh.0));

    // A past run at that read_at agrees with the resumed run.
    let past = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","asOf":"$AT","margin":"0","approvalId":"appr-snap-5","operationId":"$OP"}"#,
            &[("$ID", NETTING), ("$AT", &read_at_iso), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert!(strings(&past, "accounts").contains(&boundary.0));
    assert!(!strings(&past, "accounts").contains(&fresh.0));
    assert_equal(asset(&past, "BTC"), zero);
}

#[test]
fn runs_an_operator_ledger_invariant_as_replay_only_and_passes_a_healthy_subset() {
    let Some(k) = Kit::new() else { return };
    let holder = k.insert_account("abcdeaaa-3333-4333-8333-000000000001");
    let defined = k
        .define(&body(
            r#"{"template":"ledger_invariant","accountSet":{"mode":"explicit","accountIds":["$A"]},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[("$A", &holder)],
        ))
        .unwrap();
    assert_equal(
        at(&defined, "checkKind"),
        r#"{"status":"set","value":"replay"}"#,
    );
    let run = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-subset","operationId":"$OP"}"#,
            &[("$ID", &st(&defined, "id")), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert_eq!(st(&run, "status"), "PASS");
}

#[test]
fn reads_an_empty_set_as_nothing_to_compare_never_pass_and_counts_what_a_pass_compared_owner_288() {
    let Some(k) = Kit::new() else { return };
    // Planted fault: a control whose set holds no account. Before OWNER 288 it folded an empty asset list to PASS.
    let empty = k
        .define(&body(
            r#"{"template":"ledger_invariant","accountSet":{"mode":"query","ownerIdPrefix":"abcdeaaa-7777-4777-8777-"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&empty, "id");
    let run = || {
        k.run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-empty","operationId":"$OP"}"#,
            &[("$ID", &id), ("$OP", &k.next_op())],
        ))
        .unwrap()
    };
    let nothing = run();
    assert_eq!(st(&nothing, "status"), "NOTHING_TO_COMPARE");
    assert_eq!(at(&nothing, "compared"), &Json::int(0));
    assert!(arr(&nothing, "assets").is_empty());
    // Stored as it was judged: a fresh read of the run list shows the same word and count.
    let stored = k
        .list_runs(&body(r#"{"controlId":"$ID"}"#, &[("$ID", &id)]))
        .unwrap();
    let seen: Vec<(String, Json)> = arr(&stored, "runs")
        .iter()
        .map(|r| (st(r, "status"), at(r, "compared").clone()))
        .collect();
    assert_eq!(seen, [("NOTHING_TO_COMPARE".to_owned(), Json::int(0))]);

    // One account in the set: one record compared, no difference, PASS.
    let holder = k.insert_account("abcdeaaa-7777-4777-8777-000000000001");
    let one = run();
    assert!(
        holder.len() == 36
            && holder
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == '-')
    );
    assert_eq!(st(&one, "status"), "PASS");
    assert_eq!(at(&one, "compared"), &Json::int(1));
}

#[test]
fn names_a_threshold_asset_no_account_holds_as_a_missing_ledger_side_fail_never_a_zero_owner_288() {
    let Some(k) = Kit::new() else { return };
    let holder = k.insert_account("abcdeaaa-8888-4888-8888-000000000001");
    let defined = k
        .define(&body(
            r#"{"template":"threshold","accountSet":{"mode":"explicit","accountIds":["$A"]},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "threshold":{"bound":"max","byAsset":{"USDC":"1","USDT":"1"}},"reason":"$R","activate":true}"#,
            &[("$A", &holder)],
        ))
        .unwrap();
    let run = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-missing","operationId":"$OP"}"#,
            &[("$ID", &st(&defined, "id")), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert_eq!(st(&run, "status"), "FAIL");
    assert_equal(at(&run, "phase"), r#"{"status":"set","value":"missing"}"#);
    assert_equal(
        at(&run, "assets"),
        r#"[{"assetId":"USDC","observed":"unset","expected":"1","difference":"unset","tolerance":"0","missing":"ledger"},
            {"assetId":"USDT","observed":"0","expected":"1","difference":"0","tolerance":"0"}]"#,
    );
    assert_eq!(at(&run, "compared"), &Json::int(1));
}

#[test]
fn fails_a_replay_now_when_two_accounts_drift_by_amounts_that_cancel_in_the_asset_total() {
    let Some(k) = Kit::new() else { return };
    let funded = |user: &str| {
        k.fund(user, "ETH", "5", "test", &format!("recon-cancel-{user}"));
        k.user_account(user, "ETH")
    };
    let up = funded("abcdeaaa-5555-4555-8555-000000000001");
    let down = funded("abcdeaaa-5555-4555-8555-000000000002");
    let defined = k
        .define(&body(
            r#"{"template":"ledger_invariant","accountSet":{"mode":"explicit","accountIds":["$U","$D"]},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[("$U", &up), ("$D", &down)],
        ))
        .unwrap();
    let mut c = k.sql();
    c.execute(
        "UPDATE accounts SET balance = balance + 3 WHERE id = $1::text::uuid",
        &[&up],
    )
    .unwrap();
    c.execute(
        "UPDATE accounts SET balance = balance - 3 WHERE id = $1::text::uuid",
        &[&down],
    )
    .unwrap();
    let run = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-cancel","operationId":"$OP"}"#,
            &[("$ID", &st(&defined, "id")), ("$OP", &k.next_op())],
        ))
        .unwrap();
    assert_eq!(st(&run, "status"), "FAIL");
    // Each account drifts by 3; the asset row observes the summed size, 6, against 0.
    assert_match(
        at(&run, "assets"),
        r#"[{"assetId":"ETH","observed":"6","expected":"0","difference":"6"}]"#,
    );
}

#[test]
fn reconciles_one_rails_boundary_against_that_rails_own_statement_equal_is_pass_a_gap_is_fail_a_blank_url_is_unset_with_its_code()
 {
    let Some(k) = Kit::new() else { return };
    // Two rails take deposits; the control over recon-rail must count its boundary alone (-7), never recon-other's.
    k.fund(
        "abcdeaaa-8888-4888-8888-000000000001",
        "USDT",
        "7",
        "recon-rail",
        "recon-rail-1",
    );
    k.fund(
        "abcdeaaa-8888-4888-8888-000000000002",
        "USDT",
        "4",
        "recon-other",
        "recon-other-1",
    );
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","rail":"recon-rail","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"critical","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let amount = Arc::new(Mutex::new("-7".to_owned()));
    let asked: Arc<Mutex<Vec<Query>>> = Arc::new(Mutex::new(Vec::new()));
    let base = {
        let (amount, asked) = (amount.clone(), asked.clone());
        serve(move |req| {
            match req.path.as_str() {
            "/statement" => {
                let mut q = req.query.clone();
                q.sort();
                asked.lock().unwrap().push(q);
                // The statement lists every asset on the rail; the control is scoped to USDT and judges USDT alone.
                ok(format!(
                    r#"{{"source":"rail","rail":"{}","asOf":"2026-01-01T00:00:00.000Z","balances":[{{"assetId":"USDT","amount":"{}"}},{{"assetId":"BTC","amount":"-3"}}]}}"#,
                    req.query("rail").unwrap_or_default(),
                    amount.lock().unwrap()
                ))
            }
            "/book" => ok(
                r#"{"source":"rail","asOf":"2026-01-01T00:00:00.000Z","balances":[{"assetId":"USDT","amount":"-7"}]}"#
                    .to_owned(),
            ),
            _ => (404, Vec::new(), "{}".to_owned()),
        }
        })
    };
    let statement = format!("{base}/statement");
    let run = |sources: &Http| {
        k.run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-rail","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            sources,
        )
        .unwrap()
    };
    let rail_urls = http(None, &[("recon-rail", &statement)], None);
    let pass = run(&rail_urls);
    assert_match(
        &pass,
        r#"{"status":"PASS","outsideSide":"snapshot","sources":{"outside":{"asOf":"2026-01-01T00:00:00.000Z"}}}"#,
    );
    assert_equal(
        at(&pass, "assets"),
        r#"[{"assetId":"USDT","observed":"-7","expected":"-7","difference":"0","tolerance":"0"}]"#,
    );
    assert_eq!(arr(&pass, "accounts").len(), 1);
    assert_eq!(
        *asked.lock().unwrap(),
        [pairs(&[
            ("asOf", &st(&pass, "readAt")),
            ("rail", "recon-rail")
        ])]
    );

    // The outside side is one cent short of the boundary: FAIL to the cent, never rounded away.
    *amount.lock().unwrap() = "-6.99".to_owned();
    let fail = run(&rail_urls);
    assert_eq!(st(&fail, "status"), "FAIL");
    assert_match(
        at(&fail, "assets"),
        r#"[{"assetId":"USDT","observed":"-7","expected":"-6.99"}]"#,
    );
    assert_ne!(amt(&st(&arr(&fail, "assets")[0], "difference")), 0);

    // No URL for this rail: UNSET with the typed code, even when the whole-book snapshot URL is set and would match.
    let unset = run(&http(
        Some(&format!("{base}/book")),
        &[("recon-other", &statement)],
        None,
    ));
    assert_match(
        &unset,
        &format!(
            r#"{{"status":"UNSET","outsideSide":"unset","errorCode":{{"status":"set","value":"{RAIL_SOURCE_UNSET}"}}}}"#
        ),
    );
    assert!(
        arr(&unset, "assets")
            .iter()
            .all(|a| st(a, "expected") == "unset")
    );
    assert_eq!(asked.lock().unwrap().len(), 2);

    // A rail names its boundary itself: an owner type, an owner id prefix or a kind other than available beside it is refused.
    for clash in [
        r#""ownerType":"user""#,
        r#""ownerIdPrefix":"rail:""#,
        r#""kind":"hold""#,
    ] {
        let refused = k.define(&body(
            &format!(
                r#"{{"template":"outside_balance","accountSet":{{"mode":"query","rail":"recon-rail",{clash}}},
                    "schedule":{{"cadence":"daily","hour":0,"minute":0}},"severity":"critical","tolerance":{{"default":"0"}},
                    "reason":"$R","activate":true}}"#
            ),
            &[],
        ));
        assert!(refused.is_err(), "{clash}: {refused:?}");
    }
}

/// The open-items server's state: what it lists, its status, and every body and signature it was sent.
#[derive(Default)]
struct ItemsState {
    statement: String,
    listed: Vec<Listed>,
    status: u16,
    asked: Vec<Json>,
    bodies: Vec<String>,
    signed: Vec<String>,
    /// When set, every even-numbered read lists these less `dep-b-usdc`: an item that closes between a run's two reads.
    closing: Option<Vec<Listed>>,
}

fn items_server(
    state: &Arc<Mutex<ItemsState>>,
    rail: &'static str,
    user_id: &'static str,
    tx_prefix: &'static str,
) -> String {
    let state = state.clone();
    serve(move |req| {
        let mut s = state.lock().unwrap();
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/statement") => ok(format!(
                r#"{{"source":"rail","rail":"{}","asOf":"2026-01-01T00:00:00.000Z","balances":{}}}"#,
                req.query("rail").unwrap_or_else(|| rail.to_owned()),
                s.statement
            )),
            ("POST", "/items") => {
                let ask = j(&req.body);
                s.asked.push(ask.clone());
                s.bodies.push(req.body.clone());
                s.signed
                    .push(req.header("x-test-signed").unwrap_or_default());
                let n = s.asked.len();
                if let Some(closing) = &s.closing
                    && n.is_multiple_of(2)
                {
                    s.listed = closing
                        .iter()
                        .filter(|i| i.id != "dep-b-usdc")
                        .cloned()
                        .collect();
                }
                if s.status != 200 {
                    return (
                        s.status,
                        Vec::new(),
                        r#"{"error":"pay.custody_open_items_unavailable"}"#.to_owned(),
                    );
                }
                ok(items_page(&s.listed, user_id, tx_prefix, &ask))
            }
            _ => (404, Vec::new(), "{}".to_owned()),
        }
    })
}

#[test]
fn takes_a_rails_named_open_items_out_of_its_difference_pass_names_every_item_a_residual_of_one_unit_or_an_unlisted_transfer_fails_an_unreadable_list_is_error()
 {
    let Some(k) = Kit::new() else { return };
    // Lead ruling 2026-10-30: the rail passes only when its difference is exactly the open items svc-pay lists, each named.
    let user = "abcdeaaa-8888-4888-8888-000000000003";
    k.fund(user, "USDT", "7", "recon-items", "recon-items-1");
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","rail":"recon-items","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"critical","tolerance":{"default":"1"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let state = Arc::new(Mutex::new(ItemsState {
        status: 200,
        ..ItemsState::default()
    }));
    let set_statement = |amount: &str| {
        state.lock().unwrap().statement = format!(r#"[{{"assetId":"USDT","amount":"{amount}"}}]"#);
    };
    let base = items_server(&state, "recon-items", user, "0xtest");
    let statement = format!("{base}/statement");
    let items = format!("{base}/items");
    let sources = http(
        None,
        &[("recon-items", &statement)],
        Some(&[("recon-items", &items)]),
    );
    let run = || {
        k.run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-items","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            &sources,
        )
        .unwrap()
    };
    // Custody shows 10, the ledger 7: two held deposits (2 + 2) and one credited deposit the chain took back uncovered
    // (-1) explain it exactly. PASS, with every item named by id and amount on the run.
    set_statement("-10");
    state.lock().unwrap().listed = vec![
        held("dep-held-1", "USDT", "2"),
        held("dep-held-2", "USDT", "2"),
        unfunded("dep-unfunded-1", "USDT", "-1"),
    ];
    let pass = run();
    assert_eq!(st(&pass, "status"), "PASS");
    assert_equal(
        at(&pass, "assets"),
        r#"[{"assetId":"USDT","observed":"-7","expected":"-10","difference":"3","tolerance":"1","reconcilingItems":"3","residual":"0"}]"#,
    );
    assert_equal(
        at(&pass, "reconcilingItems"),
        r#"[{"source":"svc-pay","id":"dep-held-1","kind":"held","assetId":"USDT","amount":"2"},
            {"source":"svc-pay","id":"dep-held-2","kind":"held","assetId":"USDT","amount":"2"},
            {"source":"svc-pay","id":"dep-unfunded-1","kind":"reversal_unfunded","assetId":"USDT","amount":"-1"}]"#,
    );
    {
        // Read twice, before the ledger snapshot and after the statement, each body signed as sent.
        let s = state.lock().unwrap();
        assert_equal(
            &Json::Array(s.asked.clone()),
            r#"[{"rail":"recon-items","offset":0,"limit":200},{"rail":"recon-items","offset":0,"limit":200}]"#,
        );
        let stringified: Vec<String> = s.asked.iter().map(Json::compact).collect();
        assert_eq!(s.signed, stringified);
        assert_eq!(s.bodies, stringified);
    }
    // The stored run reads back the same items.
    let stored = k
        .list_runs(&body(r#"{"controlId":"$ID"}"#, &[("$ID", &id)]))
        .unwrap();
    let back = arr(&stored, "runs")
        .iter()
        .find(|r| st(r, "id") == st(&pass, "id"))
        .unwrap();
    assert_eq!(
        canon(at(back, "reconcilingItems")),
        canon(at(&pass, "reconcilingItems"))
    );

    // One hundredth over the items: FAIL naming the residual, though the tolerance is 1.
    set_statement("-10.01");
    let cent = run();
    assert_eq!(st(&cent, "status"), "FAIL");
    assert_match(
        &arr(&cent, "assets")[0],
        r#"{"difference":"3.01","reconcilingItems":"3","residual":"0.01"}"#,
    );

    // A transfer custody received that no item lists (2 more on the rail): FAIL, the residual is that transfer.
    set_statement("-12");
    let unlisted = run();
    assert_eq!(st(&unlisted, "status"), "FAIL");
    assert_match(
        &arr(&unlisted, "assets")[0],
        r#"{"difference":"5","reconcilingItems":"3","residual":"2"}"#,
    );
    assert_eq!(arr(&unlisted, "reconcilingItems").len(), 3);

    // No items at all and no difference: PASS with an empty, named list, not the old path.
    set_statement("-7");
    state.lock().unwrap().listed = Vec::new();
    let none = run();
    assert_eq!(st(&none, "status"), "PASS");
    assert!(arr(&none, "reconcilingItems").is_empty());
    assert_match(
        &arr(&none, "assets")[0],
        r#"{"reconcilingItems":"0","residual":"0"}"#,
    );

    // svc-pay cannot answer: ERROR at items, never PASS on the statement alone.
    state.lock().unwrap().status = 503;
    let down = run();
    assert_match(
        &down,
        &format!(
            r#"{{"status":"ERROR","phase":{{"status":"set","value":"items"}},"errorCode":{{"status":"set","value":"{SOURCE_UNAVAILABLE}"}}}}"#
        ),
    );
    assert!(down.get("reconcilingItems").is_none());
}

#[test]
fn judges_a_rail_asset_only_the_items_explain_fails_ahead_of_an_unset_asset_leaves_out_an_item_seen_after_the_statement_catches_an_item_that_moves_and_reads_a_scheduled_run_now()
 {
    let Some(k) = Kit::new() else { return };
    let user = "abcdeaaa-8888-4888-8888-000000000004";
    k.fund(user, "USDT", "7", "recon-items-b", "recon-items-b-1");
    // The ledger also holds BTC on the rail; the statement never names BTC, so BTC stays unset on every run below.
    k.fund(user, "BTC", "1", "recon-items-b", "recon-items-b-2");
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","rail":"recon-items-b"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"critical","tolerance":{"default":"1"},
                "margin":"0","reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let id = st(&defined, "id");
    // USDC: custody holds 4 the ledger never booked (a held first deposit posts nothing, so the ledger has no USDC account).
    let state = Arc::new(Mutex::new(ItemsState {
        status: 200,
        statement: r#"[{"assetId":"USDT","amount":"-10"},{"assetId":"USDC","amount":"-4"}]"#
            .to_owned(),
        ..ItemsState::default()
    }));
    let base = items_server(&state, "recon-items-b", user, "0xb");
    let statement = format!("{base}/statement");
    let items = format!("{base}/items");
    let sources = http(
        None,
        &[("recon-items-b", &statement)],
        Some(&[("recon-items-b", &items)]),
    );
    let run = |extra: &str| {
        k.run_from(
            &body(
                &format!(
                    r#"{{"controlId":"$ID","reason":"$R","approvalId":"appr-items-b","operationId":"$OP"{extra}}}"#
                ),
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            &sources,
        )
        .unwrap()
    };
    let asked = || state.lock().unwrap().asked.len();
    let set_listed = |l: Vec<Listed>| state.lock().unwrap().listed = l;
    let listed = || state.lock().unwrap().listed.clone();

    // USDT is one unit over its items (a residual of 1 within a tolerance of 1 still FAILs); USDC is explained exactly by
    // its held deposit; BTC is unset. FAIL: a known break is never hidden behind the unset asset.
    set_listed(vec![
        held("dep-b-usdt", "USDT", "2"),
        held("dep-b-usdc", "USDC", "4"),
    ]);
    let broken = run("");
    assert_eq!(st(&broken, "status"), "FAIL");
    assert_equal(
        at(&broken, "assets"),
        r#"[{"assetId":"BTC","observed":"-1","expected":"unset","difference":"unset","tolerance":"1","reconcilingItems":"0"},
            {"assetId":"USDC","observed":"0","expected":"-4","difference":"4","tolerance":"1","reconcilingItems":"4","residual":"0"},
            {"assetId":"USDT","observed":"-7","expected":"-10","difference":"3","tolerance":"1","reconcilingItems":"2","residual":"1"}]"#,
    );

    // With USDT explained too, only the unset BTC is left: UNSET, not PASS.
    let mut more = listed();
    more.push(held("dep-b-usdt-2", "USDT", "1"));
    set_listed(more);
    let unset = run("");
    assert_eq!(st(&unset, "status"), "UNSET");
    assert_match(asset(&unset, "USDT"), r#"{"residual":"0"}"#);

    // svc-pay lists what is open now: a run at a past instant cannot take items out. UNSET with its code, nothing asked.
    let before = asked();
    let past = run(&format!(
        r#","asOf":"{}","margin":"0""#,
        Instant(system_ms() - 60_000).iso()
    ));
    assert_match(
        &past,
        &format!(
            r#"{{"status":"UNSET","phase":{{"status":"set","value":"items"}},"errorCode":{{"status":"set","value":"{ITEMS_NOW_ONLY}"}}}}"#
        ),
    );
    assert!(past.get("reconcilingItems").is_none());
    assert_eq!(asked(), before);

    // Each run reads the items twice: before the ledger snapshot and after the statement.
    let reads = asked();
    run("");
    assert_eq!(asked() - reads, 2);

    // An item svc-pay saw after the statement's as-of is in neither side: left out, the run still judged and PASS-able.
    let mut with_late = listed();
    with_late.push(Listed {
        seen: Some("2026-01-01T00:00:00.001Z".to_owned()),
        ..held("dep-b-late", "USDT", "9")
    });
    set_listed(with_late);
    let late = run("");
    assert_eq!(st(&late, "status"), "UNSET");
    let ids: Vec<String> = arr(&late, "reconcilingItems")
        .iter()
        .map(|i| st(i, "id"))
        .collect();
    assert_eq!(ids, ["dep-b-usdt", "dep-b-usdc", "dep-b-usdt-2"]);
    assert_match(
        asset(&late, "USDT"),
        r#"{"reconcilingItems":"3","residual":"0"}"#,
    );
    set_listed(
        listed()
            .into_iter()
            .filter(|i| i.id != "dep-b-late")
            .collect(),
    );

    // An item that closes between the two reads (released and credited while the ledger was read): ERROR, run it again.
    let closing = listed();
    state.lock().unwrap().closing = Some(closing.clone());
    let moved = run("");
    assert_match(
        &moved,
        &format!(
            r#"{{"status":"ERROR","phase":{{"status":"set","value":"items"}},"errorCode":{{"status":"set","value":"{ITEMS_MOVED}"}}}}"#
        ),
    );
    assert!(moved.get("reconcilingItems").is_none());
    state.lock().unwrap().closing = None;
    set_listed(closing.clone());

    // A scheduled run on this rail reads the tick's instant, not a past one, so it is judged (UNSET here by BTC alone).
    k.run_due(&sources);
    let scheduled: (String, String, i64, i64) = {
        let r = k
            .sql()
            .query_one(
                "SELECT status, error_code, floor(extract(epoch FROM read_at) * 1000)::int8,
                        floor(extract(epoch FROM as_of) * 1000)::int8
                   FROM reconciliation_control_runs
                  WHERE control_id = $1::text::uuid AND operation_id LIKE 'schedule:%' ORDER BY period_start DESC LIMIT 1",
                &[&id],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    };
    assert_eq!((scheduled.0.as_str(), scheduled.1.as_str()), ("UNSET", ""));
    assert!(scheduled.2 >= scheduled.3);

    // A residual still FAILs when an asset only the items name has no tolerance: the tolerance plays no part with items.
    k.sql()
        .execute(
            "UPDATE reconciliation_controls SET tolerance = '{\"byAsset\":{\"USDT\":\"0\",\"BTC\":\"0\"}}'::jsonb WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    set_listed(
        closing
            .into_iter()
            .filter(|i| i.id != "dep-b-usdt-2")
            .collect(),
    );
    let no_tolerance = run("");
    assert_eq!(st(&no_tolerance, "status"), "FAIL");
    // USDC has no tolerance, so its evidence keeps no difference (as on every path), and the USDT break still FAILs.
    assert_match(
        asset(&no_tolerance, "USDC"),
        r#"{"tolerance":"unset","difference":"unset"}"#,
    );
    assert_match(asset(&no_tolerance, "USDT"), r#"{"residual":"1"}"#);
}

#[test]
fn leaves_a_past_run_on_a_rail_with_no_open_items_url_as_it_was_the_statement_is_judged_never_unset_for_items()
 {
    let Some(k) = Kit::new() else { return };
    k.fund(
        "abcdeaaa-8888-4888-8888-000000000005",
        "USDT",
        "7",
        "recon-noitems",
        "recon-noitems-1",
    );
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","rail":"recon-noitems","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"critical","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let base = serve(|req| {
        ok(format!(
            r#"{{"source":"rail","rail":"recon-noitems","asOf":"{}","balances":[{{"assetId":"USDT","amount":"-9"}}]}}"#,
            req.query("asOf").unwrap_or_default()
        ))
    });
    // The past instant must come after the deposit, so the ledger side is 7.
    pause(500);
    // Items are wired for another rail only.
    let statement = format!("{base}/statement");
    let items = format!("{base}/items");
    let sources = http(
        None,
        &[("recon-noitems", &statement)],
        Some(&[("recon-items-b", &items)]),
    );
    let past = k
        .run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-noitems","operationId":"$OP","asOf":"$AT","margin":"0"}"#,
                &[
                    ("$ID", &st(&defined, "id")),
                    ("$OP", &k.next_op()),
                    ("$AT", &Instant(system_ms() - 200).iso()),
                ],
            ),
            &sources,
        )
        .unwrap();
    assert_eq!(st(&past, "status"), "FAIL");
    assert!(!subset(
        &j(&format!(r#"{{"value":"{ITEMS_NOW_ONLY}"}}"#)),
        at(&past, "errorCode")
    ));
    assert!(past.get("reconcilingItems").is_none());
}

#[test]
fn refuses_an_operator_run_in_the_scheduled_operation_id_space() {
    let Some(k) = Kit::new() else { return };
    let refused = k
        .run(&body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-reserved","operationId":"schedule:11111111-1111-4111-8111-111111111111:2026-10-24T00:00:00.000Z"}"#,
            &[("$ID", REPLAY)],
        ))
        .unwrap_err();
    assert_eq!(code(&refused), "ledger.idempotency_conflict");
}

#[test]
fn reads_the_outside_snapshot_over_http_matching_is_pass_an_unreadable_source_is_error_and_every_evaluation_stays_listed_after_retire()
 {
    let Some(k) = Kit::new() else { return };
    let owner = "abcdefab-7777-4777-8777-";
    k.insert_account(&format!("{owner}000000000001"));
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","assetId":"USDT","ownerIdPrefix":"$O"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"warning","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[("$O", owner)],
        ))
        .unwrap();
    let id = st(&defined, "id");
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    let base = {
        let asked = asked.clone();
        serve(move |req| {
            match req.path.as_str() {
            "/snapshot" => {
                asked
                    .lock()
                    .unwrap()
                    .push(req.query("asOf").unwrap_or_else(|| "undefined".to_owned()));
                ok(r#"{"source":"rail","asOf":"2026-01-01T00:00:00.000Z","balances":[{"assetId":"USDT","amount":"0"}]}"#.to_owned())
            }
            "/broken" => ok(r#"{"source":"rail","balances":"no"}"#.to_owned()),
            "/future" => ok(r#"{"source":"rail","asOf":"2999-01-01T00:00:00.000Z","balances":[{"assetId":"USDT","amount":"0"}]}"#.to_owned()),
            "/moved" => (
                302,
                vec![("location".to_owned(), "/snapshot".to_owned())],
                String::new(),
            ),
            _ => (404, Vec::new(), r#"{"message":"Route not found"}"#.to_owned()),
        }
        })
    };
    let run = |sources: &Http| {
        k.run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-outside","operationId":"$OP"}"#,
                &[("$ID", &id), ("$OP", &k.next_op())],
            ),
            sources,
        )
        .unwrap()
    };
    let pass = run(&http(Some(&format!("{base}/snapshot")), &[], None));
    assert_match(
        &pass,
        r#"{"status":"PASS","outsideSide":"snapshot","sources":{"outside":{"asOf":"2026-01-01T00:00:00.000Z"}}}"#,
    );
    assert_eq!(*asked.lock().unwrap(), [st(&pass, "readAt")]);

    // Not a snapshot, dated after the instant asked for, a redirect, a 404, and a closed port: each is ERROR with the
    // typed code, never PASS.
    let unreadable = [
        format!("{base}/broken"),
        format!("{base}/future"),
        format!("{base}/moved"),
        format!("{base}/missing"),
        "http://127.0.0.1:9/closed".to_owned(),
    ];
    let errors: Vec<Json> = unreadable
        .iter()
        .map(|url| run(&http(Some(url), &[], None)))
        .collect();
    for (url, error) in unreadable.iter().zip(&errors) {
        assert!(
            subset(
                &j(&format!(
                    r#"{{"status":"ERROR","phase":{{"status":"set","value":"outside"}},"errorCode":{{"status":"set","value":"{SOURCE_UNAVAILABLE}"}},"outsideSide":"unavailable","assets":[]}}"#
                )),
                error
            ),
            "{url}: {}",
            error.compact()
        );
    }
    // The snapshot was asked once: the redirect was never followed.
    assert_eq!(asked.lock().unwrap().len(), 1);
    // No URL: the outside side is unset, as before.
    assert_eq!(st(&run(&http(None, &[], None)), "status"), "UNSET");

    k.update(&body(
        r#"{"controlId":"$ID","reason":"$R","lifecycle":"retire","approvalId":"appr-retire","operationId":"$OP"}"#,
        &[("$ID", &id), ("$OP", &k.next_op())],
    ))
    .unwrap();
    let listed = k
        .list_runs(&body(r#"{"controlId":"$ID"}"#, &[("$ID", &id)]))
        .unwrap();
    assert_eq!(at(&listed, "total"), &Json::int(7));
    // Newest first by when each run started: the unset run was the last one.
    let statuses: Vec<String> = arr(&listed, "runs")
        .iter()
        .map(|r| st(r, "status"))
        .collect();
    assert_eq!(
        statuses,
        ["UNSET", "ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "PASS"]
    );
    let mut ids: Vec<String> = arr(&listed, "runs").iter().map(|r| st(r, "id")).collect();
    for wanted in std::iter::once(&pass).chain(&errors) {
        assert!(ids.contains(&st(wanted, "id")));
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 7);
    let two = k
        .list_runs(&body(r#"{"controlId":"$ID","limit":2}"#, &[("$ID", &id)]))
        .unwrap();
    assert_eq!(at(&two, "total"), &Json::int(7));
    assert_eq!(
        canon(at(&two, "runs")),
        canon(&Json::Array(arr(&listed, "runs")[..2].to_vec()))
    );
    let missing = k
        .list_runs(&j(
            r#"{"controlId":"00000000-0000-4000-8000-00000000abcd"}"#,
        ))
        .unwrap_err();
    assert_eq!(code(&missing), CONTROL_NOT_FOUND);
}

/// A whole-book source with balances but no as-of.
struct NoAsOf;

impl Sources for NoAsOf {
    fn outside_balance(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Snapshot {
            as_of: None,
            balances: pairs(&[("USDT", "0")]),
        }
    }
    fn rail_statement(&self, _: i64, _: &str) -> SnapshotRead {
        SnapshotRead::Unset
    }
    fn parity(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Unset
    }
}

#[test]
fn keeps_an_outside_snapshot_with_no_as_of_unset_rather_than_the_ledger_time() {
    let Some(k) = Kit::new() else { return };
    // Earlier TypeScript cases leave USDT accounts in the book; one stands for them, so the set is not empty.
    k.insert_account("abcdeaaa-0000-4000-8000-000000000001");
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let run = k
        .run_from(
            &body(
                r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-noasof","operationId":"$OP"}"#,
                &[("$ID", &st(&defined, "id")), ("$OP", &k.next_op())],
            ),
            &NoAsOf,
        )
        .unwrap();
    assert_equal(at(&run, "sources.outside"), r#"{"asOf":"unset"}"#);
}

#[test]
fn keeps_running_later_controls_when_one_scheduled_control_throws() {
    let Some(k) = Kit::new() else { return };
    let define = |margin: &str| {
        let defined = k
            .define(&body(
                r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},
                    "schedule":{"cadence":"hourly","minute":0},"severity":"info","tolerance":{"default":"0"},
                    "threshold":{"bound":"max","byAsset":{"USDT":"1000"}},"margin":"$M","reason":"$R","activate":true}"#,
                &[("$M", margin)],
            ))
            .unwrap();
        st(&defined, "id")
    };
    let broken = define("99999999");
    let healthy = define("0");
    let failed = controls::run_due(&k.store, &Unset).unwrap();
    // The broken control is the one that threw, by its margin.
    assert!(
        failed
            .iter()
            .all(|f| f.control_id == broken && f.message == MARGIN_UNSET),
        "{failed:?}"
    );
    let runs: Vec<String> = k
        .sql()
        .query(
            "SELECT control_id::text FROM reconciliation_control_runs WHERE control_id = ANY($1::text[]::uuid[])",
            &[&vec![broken.clone(), healthy.clone()]],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(runs.contains(&healthy));
}

#[test]
fn reaches_define_and_run_on_the_operator_port() {
    let Some(k) = Kit::new() else { return };
    // Earlier TypeScript cases leave USDT accounts in the book, each at 0; one stands for them, so a min-0 bound PASSes.
    k.insert_account("abcdeaaa-0000-4000-8000-000000000001");
    let d = door(&k, Arc::new(Unset));
    let treasury = || Some(bearer(&["admin:treasury"], true));
    let send =
        |path: &str, auth: Option<String>, payload: &str| call(&d, "POST", path, auth, payload);
    let (status, refused) = send(
        "/operator/reconciliation/controls",
        treasury(),
        &body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},"reason":"$R","activate":true}"#,
            &[],
        )
        .compact(),
    );
    assert_eq!(status, 412);
    assert_eq!(door_code(&refused), Some(POLICY_UNSET));
    let (status, defined) = send(
        "/operator/reconciliation/controls",
        treasury(),
        &body(
            r#"{"template":"threshold","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":1,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "threshold":{"bound":"min","byAsset":{"USDT":"0"}},"reason":"$R","activate":true}"#,
            &[],
        )
        .compact(),
    );
    assert_eq!(status, 200);
    let control_id = st(&defined, "id");
    let (status, run) = send(
        "/operator/reconciliation/controls/run",
        treasury(),
        &body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-http","operationId":"$OP"}"#,
            &[("$ID", &control_id), ("$OP", &k.next_op())],
        )
        .compact(),
    );
    assert_eq!(status, 200);
    assert_match(
        &run,
        &format!(r#"{{"controlId":"{control_id}","status":"PASS"}}"#),
    );
    let runs_body = format!(r#"{{"controlId":"{control_id}"}}"#);
    let (status, runs) = send(
        "/operator/reconciliation/controls/runs",
        treasury(),
        &runs_body,
    );
    assert_eq!(status, 200);
    assert_match(
        &runs,
        &format!(
            r#"{{"controlId":"{control_id}","total":1,"runs":[{{"id":"{}","status":"PASS"}}]}}"#,
            st(&run, "id")
        ),
    );
    let (status, _) = send(
        "/operator/reconciliation/controls/runs",
        Some(bearer(&["admin:compliance"], false)),
        &runs_body,
    );
    assert_eq!(status, 200);
    let (status, _) = send(
        "/operator/reconciliation/controls/runs",
        treasury(),
        r#"{"controlId":"x"}"#,
    );
    assert_eq!(status, 400);
    let (status, _) = call(&d, "GET", "/operator/reconciliation/controls", None, "");
    assert_eq!(status, 401);
    let (status, _) = send("/operator/reconciliation/controls/runs", None, &runs_body);
    assert_eq!(status, 401);
}

#[test]
fn runs_on_the_operator_port_with_the_outside_source_it_was_given_unreadable_is_error() {
    let Some(k) = Kit::new() else { return };
    // Earlier TypeScript cases leave USDT accounts in the book; one stands for them, so the set is not empty.
    k.insert_account("abcdeaaa-0000-4000-8000-000000000001");
    let d = door(
        &k,
        Arc::new(http(Some("http://127.0.0.1:9/closed"), &[], None)),
    );
    let defined = k
        .define(&body(
            r#"{"template":"outside_balance","accountSet":{"mode":"query","assetId":"USDT"},
                "schedule":{"cadence":"daily","hour":0,"minute":0},"severity":"info","tolerance":{"default":"0"},
                "reason":"$R","activate":true}"#,
            &[],
        ))
        .unwrap();
    let (status, run) = call(
        &d,
        "POST",
        "/operator/reconciliation/controls/run",
        Some(bearer(&["admin:treasury"], true)),
        &body(
            r#"{"controlId":"$ID","reason":"$R","approvalId":"appr-http-outside","operationId":"$OP"}"#,
            &[("$ID", &st(&defined, "id")), ("$OP", &k.next_op())],
        )
        .compact(),
    );
    assert_eq!(status, 200);
    assert_match(
        &run,
        &format!(
            r#"{{"status":"ERROR","errorCode":{{"status":"set","value":"{SOURCE_UNAVAILABLE}"}}}}"#
        ),
    );
}
