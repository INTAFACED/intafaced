//! Ported from the TypeScript service's \`recovery-native.test.ts\` ("native recovery safeguards"): each of its cases runs
//! here on the real Rust engine, its real file journal on disk, and its real door (\`MatchingDoor::decide\`) or binary.
//! "After reload" is what it is in the TypeScript: the engine is dropped (which closes its journal and releases the
//! writer lock), the file is opened again and a fresh engine recovers from it.
//!
//! Where the port differs, by case:
//! - "an ambiguous fsync cannot admit a second input at the same journal sequence": the TypeScript replaces
//!   \`fs.fsyncSync\` with one that syncs and then throws. Rust's \`File::sync_all\` cannot be replaced from a test, so the
//!   journal's unknown-outcome latch (\`FileJournal\`'s \`io_unknown\`, which both the failed write and the failed fsync
//!   set) is reached here through a write the kernel refuses (\`EFBIG\` under \`RLIMIT_FSIZE\`, the launcher
//!   \`tests/journal_file.rs\` uses). What is proven is the same: after an append whose outcome is unknown, the next
//!   append refuses \`journal_io_unknown\`, and a reopen reads exactly the durable records at their own sequences.
//!   The fsync branch's own line is not reached by any test (see \`PORT.md\`).
//! - "a lost fill publication keeps the accepted client ID claimed, including after reload" is two tests here: that
//!   the publication failure is returned and the fill stays durable through a reload is
//!   \`a_lost_fill_publication_is_returned_and_the_durable_fill_survives_reload\`; the claim itself
//!   (\`core-tif.ts\`'s \`client_order_id_reuse\`, \`src/engine/client_ids.rs\`) is
//!   \`defect_a_lost_fill_publication_keeps_the_accepted_client_id_claimed_including_after_reload\`, named for the defect
//!   it first caught: the Rust engine had no claim.
//! - "two signals share one drain and cannot close a native journal before HTTP drains": \`shutdownMatching\` is the
//!   binary's own drain here (\`src/main.rs\`: the signal sets one flag, the server returns once every request in flight
//!   is answered, and only then the journal is closed). The test runs the binary, holds one request open mid-body,
//!   sends SIGTERM twice and SIGINT, and checks the journal's writer lock is still held until that request is answered,
//!   and that the process then exits 0 once with the lock released.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_matching::approval::Stub;
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::types::{EngineOrder, Opt, OrderType, Side, Tif};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::liquidity::{MassQuote, MassQuoteResult};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::env::parse_operator_ids;
use svc_matching::journal::replay::MemorySnapshotSink;
use svc_matching::journal::{
    EngineJournal, FileJournal, JOURNAL_LOCKED, JournalCommand, JournalError, MemoryJournal,
};

const MARKET: &str = "BTC-USDT";
const SECRET: &str = "matching-native-recovery-secret-at-least-32";
/// 2026-10-11T00:00:00Z.
const START_MS: i64 = 1_791_676_800_000;

/// \`ID(n)\`.
fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(START_MS) };
}

/// \`clock: () => new Date('2026-10-11T00:00:00Z')\`.
fn clock() -> i64 {
    NOW.with(Cell::get)
}

/// \`order(n, accountId, side)\`: a GTC limit of 1 at 100.
fn order(n: u32, account: &str, side: Side) -> EngineOrder {
    EngineOrder::new(
        id(n),
        account,
        OrderType::Limit,
        side,
        a("1"),
        Some(a("100")),
        Tif::Gtc,
    )
}

/// A bus the test reads after handing it to the engine; \`refuse_all\` is the TypeScript's \`failing\` bus.
#[derive(Clone, Default)]
struct Bus {
    seen: Arc<Mutex<Vec<Published>>>,
    refuse_all: Option<&'static str>,
}

impl EventBus for Bus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        if let Some(why) = self.refuse_all {
            return Err(why.to_owned());
        }
        let mut inner = MemoryEventBus::default();
        inner.publish(name, payload, key)?;
        self.seen.lock().unwrap().extend(inner.published);
        Ok(())
    }
}

impl Bus {
    fn failing(why: &'static str) -> Bus {
        Bus {
            refuse_all: Some(why),
            ..Bus::default()
        }
    }

    /// \`bus.emitted(name)\`: each payload and its idempotency key.
    fn emitted(&self, name: &str) -> Vec<(Json, String)> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == name)
            .map(|e| (e.payload.clone(), e.key.clone()))
            .collect()
    }

    fn published(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

fn engine_on(journal: Box<dyn EngineJournal + Send>, bus: Bus) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(bus),
        clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

/// \`mkdtempSync(join(tmpdir(), prefix))\`.
fn temp_dir(prefix: &str) -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("{prefix}{name}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A live engine on the file journal at \`path\`.
fn live(path: &Path, bus: Bus) -> MatchingEngine {
    engine_on(Box::new(FileJournal::open(path).unwrap()), bus)
}

/// After reload: a fresh engine on the journal opened again, recovered.
fn reloaded(path: &Path, bus: Bus) -> MatchingEngine {
    let mut engine = live(path, bus);
    engine.recover().unwrap();
    engine
}

fn submits(engine: &MatchingEngine) -> usize {
    engine
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some("submit"))
        .count()
}

fn code(r: Option<&svc_matching::book::types::Reject>) -> Option<&str> {
    r.map(|r| r.code.as_str())
}

// ── assignment across writers ───────────────────────────────────────────

/// The option contract of the case: 1 at 10, strike 100, expiry 2026-12-31.
fn contract(n: u32, account: &str, side: Side) -> EngineOrder {
    let mut o = order(n, account, side);
    o.price = Some(a("10"));
    o.strike = Opt::Some(a("100"));
    o.expiry = Opt::Some("2026-12-31T00:00:00Z".to_owned());
    o
}

#[test]
fn assignment_preserves_fill_order_across_writers_with_the_same_attribution_after_reload() {
    let dir = temp_dir("matching-option-native-");
    let path = dir.join("journal.ndjson");
    let bus = Bus::default();
    let mut engine = live(&path, bus.clone());
    for (sell, buy, writer) in [
        (51, 52, "writer-a"),
        (53, 54, "writer-b"),
        (55, 56, "writer-a"),
    ] {
        let maker = engine
            .submit(MARKET, &contract(sell, writer, Side::Sell), None)
            .unwrap();
        let taker = engine
            .submit(MARKET, &contract(buy, "holder", Side::Buy), None)
            .unwrap();
        assert!(
            maker.accepted && taker.accepted && taker.fills.len() == 1,
            "option contract not admitted: {:?} {:?}",
            maker.rejected,
            taker.rejected
        );
    }
    let mut exercise = contract(57, "holder", Side::Sell);
    exercise.price = None;
    exercise.exercise = true;
    exercise.qty = a("2");
    let applied = engine.submit(MARKET, &exercise, None).unwrap();
    assert!(applied.accepted, "{:?}", applied.rejected);
    let makers: Vec<String> = applied
        .fills
        .iter()
        .map(|f| f.maker_order_id.clone())
        .collect();
    assert_eq!(makers, [id(51), id(53)]);

    let before = engine.serialize();
    drop(engine);
    let recovered_bus = Bus::default();
    let recovered = reloaded(&path, recovered_bus.clone());
    assert_eq!(recovered.serialize(), before);
    let payloads = |b: &Bus| -> Vec<Json> {
        b.emitted("orderFilled")
            .into_iter()
            .map(|(p, _)| p)
            .collect()
    };
    assert!(!payloads(&bus).is_empty());
    assert_eq!(payloads(&recovered_bus), payloads(&bus));
    drop(recovered);
    let _ = fs::remove_dir_all(&dir);
}

// ── the recover gate ────────────────────────────────────────────────────

#[test]
fn an_abandoned_recover_gate_refuses_without_deleting_another_recoverers_ownership() {
    let dir = temp_dir("matching-recover-gate-native-");
    let path = dir.join("journal.ndjson");
    let mut first = FileJournal::open(&path).unwrap();
    first
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("cancel")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str("2026-10-11T00:00:00Z")),
            ("orderId", Json::str(id(41))),
        ])))
        .unwrap();
    first.close().unwrap();
    let before = fs::read(&path).unwrap();
    let lock = dir.join("journal.ndjson.lock");
    let gate = dir.join("journal.ndjson.lock.recover");
    fs::write(&lock, "1000000000\nstale-writer\n").unwrap();
    fs::create_dir(&gate).unwrap();
    fs::write(gate.join("owner"), "1000000000\nstale-recoverer\n").unwrap();

    let recovered = FileJournal::open(&path);
    let Err(e) = recovered else {
        panic!("a stale recover gate was taken over")
    };
    assert!(matches!(e, JournalError::Locked { .. }), "{e}");
    assert_eq!(e.code(), Some(JOURNAL_LOCKED));
    assert_eq!(
        fs::read_to_string(gate.join("owner")).unwrap(),
        "1000000000\nstale-recoverer\n"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}

// ── an append whose outcome is unknown ──────────────────────────────────

fn cancel_of(order_id: &str, at: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str("cancel")),
        ("marketId", Json::str(MARKET)),
        ("at", Json::str(at)),
        ("orderId", Json::str(order_id)),
    ]))
}

/// The child: run alone it does nothing. With \`RECOVERY_CHILD\` set it opens the journal, then lowers its own file-size
/// limit to 0 (\`SIGXFSZ\` ignored, as the binary ignores it) so the kernel refuses the next write outright, appends
/// \`second\` (its outcome unknown to the journal) and then \`third\`, restores the limit, and writes both errors.
#[test]
fn recovery_child() {
    use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
    let Ok(child) = std::env::var("RECOVERY_CHILD") else {
        return;
    };
    assert_eq!(child, "unknown-append");
    signal_hook::flag::register(
        signal_hook::consts::SIGXFSZ,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
    .unwrap();
    let path = PathBuf::from(std::env::var("JOURNAL_PATH").unwrap());
    let mut journal = FileJournal::open(&path).unwrap();
    let message = |r: Result<_, JournalError>| match r {
        Ok(_) => "admitted".to_owned(),
        Err(e) => e.to_string(),
    };
    let saved = getrlimit(Resource::Fsize);
    setrlimit(
        Resource::Fsize,
        Rlimit {
            current: Some(0),
            maximum: saved.maximum,
        },
    )
    .unwrap();
    let first_error = message(journal.append(&cancel_of("second", "2026-10-11T00:00:00Z")));
    let second_error = message(journal.append(&cancel_of("third", "2026-10-11T00:00:00Z")));
    setrlimit(Resource::Fsize, saved).unwrap();
    // With the limit back, the latch still holds: the journal admits nothing until it is opened again.
    let third_error = message(journal.append(&cancel_of("fourth", "2026-10-11T00:00:00Z")));
    let status = Json::obj([
        ("firstError", Json::str(first_error)),
        ("secondError", Json::str(second_error)),
        ("thirdError", Json::str(third_error)),
        ("length", Json::int(i64::try_from(journal.len()).unwrap())),
    ]);
    fs::write(std::env::var("JOURNAL_STATUS").unwrap(), status.compact()).unwrap();
    journal.close().unwrap();
}

#[test]
fn an_append_whose_outcome_is_unknown_cannot_admit_a_second_input_at_the_same_journal_sequence() {
    let dir = temp_dir("matching-fsync-native-");
    let path = dir.join("journal.ndjson");
    let status_path = dir.join("status.json");
    let mut setup = FileJournal::open(&path).unwrap();
    setup
        .append(&cancel_of("first", "2026-10-11T00:00:00Z"))
        .unwrap();
    setup.close().unwrap();
    let durable = fs::read(&path).unwrap();

    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            // Its full name in the test binary, `ported_b_recovery::recovery_child` (tests/it.rs), for `--exact`.
            concat!(module_path!(), "::recovery_child")
                .split_once("::")
                .map_or("recovery_child", |(_, name)| name),
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("RECOVERY_CHILD", "unknown-append")
        .env("JOURNAL_PATH", &path)
        .env("JOURNAL_STATUS", &status_path)
        .output()
        .unwrap();
    let output = format!(
        "status={}\n{}{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(status_path.exists(), "{output}");
    let status = json::parse(&fs::read_to_string(&status_path).unwrap()).unwrap();
    let text = |k: &str| match status.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?}\n{output}"),
    };
    let first_error = text("firstError");
    // The first append failed in the kernel: an error, not an admission, and not a known short write.
    assert_ne!(first_error, "admitted", "{output}");
    assert!(
        !first_error.contains("short journal write"),
        "{first_error}"
    );
    assert!(
        !first_error.starts_with("journal_io_unknown"),
        "{first_error}"
    );
    // The next appends are refused by the latch before they can take a sequence, the limit restored or not.
    for k in ["secondError", "thirdError"] {
        let e = text(k);
        assert!(e.starts_with("journal_io_unknown: "), "{k}: {e}\n{output}");
        assert!(
            e.contains("close and recover before admitting another input"),
            "{e}"
        );
    }
    assert_eq!(status.get("length"), Some(&Json::int(1)));
    assert_eq!(
        fs::read(&path).unwrap(),
        durable,
        "nothing reached the file"
    );

    let mut reopened = FileJournal::open(&path).unwrap();
    let records = reopened.read();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].seq(), Some(1));
    assert_eq!(records[0].field("orderId"), Some(&Json::str("first")));
    // Recovery read the durable prefix again: the next input takes the next sequence, never a second seq 1.
    let next = reopened
        .append(&cancel_of("after-recovery", "2026-10-11T00:00:00Z"))
        .unwrap();
    assert_eq!(next.seq(), Some(2));
    drop(reopened);
    let _ = fs::remove_dir_all(&dir);
}

// ── FOK and an OCO pair ─────────────────────────────────────────────────

#[test]
fn fok_cannot_count_the_sibling_removed_by_its_first_print() {
    let mut book = OrderBook::new(MARKET);
    let mut first = order(1, "a", Side::Sell);
    first.oco_sibling_id = Some(id(2));
    let mut second = order(2, "b", Side::Sell);
    second.oco_sibling_id = Some(id(1));
    assert!(book.submit(&first, None).accepted);
    assert!(book.submit(&second, None).accepted);
    let before = book.to_state().compact();

    let mut taker = order(3, "taker", Side::Buy);
    taker.qty = a("2");
    taker.tif = Tif::Fok;
    let result = book.submit(&taker, None);

    assert_eq!(code(result.rejected.as_ref()), Some("fok_unfillable"));
    assert!(result.fills.is_empty());
    assert_eq!(book.to_state().compact(), before);
}

// ── a lost fill publication ─────────────────────────────────────────────

fn client(mut o: EngineOrder, client_order_id: &str) -> EngineOrder {
    o.client_order_id = Some(client_order_id.to_owned());
    o.environment = Some("paper".to_owned());
    o
}

/// The maker rests on a healthy engine; an engine whose bus refuses every publication then takes it with a client
/// order id. Returns that engine (recovered on the same journal) and the error its submit returned.
fn lost_publication(path: &Path) -> (MatchingEngine, String) {
    let mut engine = live(path, Bus::default());
    engine
        .submit(MARKET, &order(11, "maker", Side::Sell), None)
        .unwrap();
    drop(engine);
    let mut first = reloaded(path, Bus::failing("publication ACK lost"));
    let Err(e) = first.submit(
        MARKET,
        &client(order(12, "taker", Side::Buy), "accepted-client"),
        None,
    ) else {
        panic!("a lost publication was reported as delivered")
    };
    (first, e.to_string())
}

#[test]
fn a_lost_fill_publication_is_returned_and_the_durable_fill_survives_reload() {
    let dir = temp_dir("matching-recovery-native-");
    let path = dir.join("journal.ndjson");
    let (first, error) = lost_publication(&path);
    assert!(error.contains("publication ACK lost"), "{error}");
    // The fill is durable and on the book: the maker no longer rests.
    assert_eq!(submits(&first), 2);
    assert_eq!(first.resting_order_count(), 0);
    let state = first.serialize();
    drop(first);
    let bus = Bus::default();
    let recovered = reloaded(&path, bus.clone());
    assert_eq!(recovered.serialize(), state);
    let fills = bus.emitted("orderFilled");
    assert_eq!(
        fills.len(),
        1,
        "the durable fill is announced again on reload"
    );
    assert_eq!(fills[0].0.get("takerOrderId"), Some(&Json::str(id(12))));
    drop(recovered);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn defect_a_lost_fill_publication_keeps_the_accepted_client_id_claimed_including_after_reload() {
    let dir = temp_dir("matching-recovery-native-");
    let path = dir.join("journal.ndjson");
    let (mut first, _) = lost_publication(&path);
    let retry = first.submit(
        MARKET,
        &client(order(13, "taker", Side::Buy), "accepted-client"),
        None,
    );
    let retry = retry.unwrap_or_else(|e| panic!("the retry was admitted and then failed: {e}"));
    assert_eq!(code(retry.rejected.as_ref()), Some("client_order_id_reuse"));
    assert_eq!(submits(&first), 2);
    drop(first);
    let mut recovered = reloaded(&path, Bus::default());
    let again = recovered
        .submit(
            MARKET,
            &client(order(14, "taker", Side::Buy), "accepted-client"),
            None,
        )
        .unwrap();
    assert_eq!(code(again.rejected.as_ref()), Some("client_order_id_reuse"));
    drop(recovered);
    let _ = fs::remove_dir_all(&dir);
}

// ── a quote leg that already filled ─────────────────────────────────────

fn statuses(r: &MassQuoteResult) -> Vec<&'static str> {
    r.results
        .iter()
        .map(|s| if s.applied { "APPLIED" } else { "REFUSED" })
        .collect()
}

#[test]
fn a_quote_leg_that_already_filled_remains_applied_when_the_other_side_refuses() {
    let dir = temp_dir("matching-recovery-native-");
    let path = dir.join("journal.ndjson");
    let bus = Bus::default();
    let mut engine = live(&path, bus.clone());
    engine
        .submit(MARKET, &order(21, "maker", Side::Sell), None)
        .unwrap();
    let mut ask = order(23, "taker", Side::Sell);
    ask.price = None;
    let result = engine
        .mass_quote(&MassQuote {
            set_id: "quote".to_owned(),
            market_id: MARKET.to_owned(),
            account_id: "taker".to_owned(),
            one_sided: false,
            bid: Some(order(22, "taker", Side::Buy)),
            ask: Some(ask),
            lifecycle_proof: None,
        })
        .unwrap();
    assert_eq!(statuses(&result), ["APPLIED", "REFUSED"]);
    assert_eq!(bus.emitted("orderFilled").len(), 1);
    let before = engine.serialize();
    drop(engine);
    let recovered = reloaded(&path, Bus::default());
    assert_eq!(recovered.serialize(), before);
    drop(recovered);
    let _ = fs::remove_dir_all(&dir);
}

// ── strict mass-quote signatures ────────────────────────────────────────

fn now_ms() -> i64 {
    system_seconds() * 1000
}

#[test]
fn strict_mass_quote_requests_refuse_unsigned_and_changed_signed_bytes_before_journal_or_order_effects()
 {
    let bus = Bus::default();
    let engine = engine_on(Box::new(MemoryJournal::new()), bus.clone());
    let door = MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: None,
            edge_key: None,
            clock: now_ms,
            approvals: Box::new(Stub {
                approver_id: "ops-confirm".to_owned(),
                requester_id: "ops-1".to_owned(),
            }),
            operator_ids: parse_operator_ids(Some("ops-1, ops-confirm")),
        },
        engine,
    )
    .unwrap();
    let payload = Json::obj([
        ("setId", Json::str("quote")),
        ("accountId", Json::str("a")),
        (
            "bid",
            Json::obj([
                ("orderId", Json::str(id(31))),
                ("type", Json::str("limit")),
                ("qty", Json::str("1")),
                ("price", Json::str("100")),
                ("tif", Json::str("GTC")),
            ]),
        ),
    ])
    .compact();
    let url = format!("/markets/{MARKET}/mass-quote");
    let post = |body: &str, signed_over: Option<&str>| -> u16 {
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        if let Some(signed) = signed_over {
            headers.extend(legacy_headers("svc-trade", SECRET, signed, system_seconds()).unwrap());
        }
        match door.decide(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body,
        }) {
            Outcome::Answer(r) => r.status,
            Outcome::Owed(s) => panic!("mass-quote is owed by {}", s.name()),
        }
    };

    assert_eq!(post(&payload, None), 401, "unsigned");
    let changed = payload.replace("\"100\"", "\"101\"");
    assert_ne!(changed, payload);
    assert_eq!(post(&changed, Some(&payload)), 401, "changed signed bytes");
    assert_eq!(
        post(&payload, Some(&payload)),
        400,
        "missing lifecycle proof"
    );
    assert!(door.engine().journal().is_empty());
    assert_eq!(door.engine().resting_order_count(), 0);
    assert_eq!(bus.published(), 0);
}

// ── two signals, one drain ──────────────────────────────────────────────

/// A stand-in NATS (\`tests/binary.rs\`'s): \`INFO\`, a \`PONG\` for every \`PING\`, a JetStream answer for every request.
fn fake_nats() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut out) = conn else { return };
            std::thread::spawn(move || {
                let mut input = BufReader::new(out.try_clone().unwrap());
                out.write_all(b"INFO {\"server_id\":\"fake\",\"headers\":true}\r\n")
                    .unwrap();
                loop {
                    let mut line = String::new();
                    if input.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    match parts.first().copied() {
                        Some("PING") => out.write_all(b"PONG\r\n").unwrap(),
                        Some(verb @ ("PUB" | "HPUB")) => {
                            let reply = parts[2].to_owned();
                            let total: usize = parts.last().unwrap().parse().unwrap();
                            let mut body = vec![0u8; total + 2];
                            input.read_exact(&mut body).unwrap();
                            let ack = if verb == "PUB" {
                                br#"{"config":{"name":"INTAFACED_MATCHING"}}"#.to_vec()
                            } else {
                                br#"{"stream":"INTAFACED_MATCHING","seq":1}"#.to_vec()
                            };
                            out.write_all(format!("MSG {reply} 1 {}\r\n", ack.len()).as_bytes())
                                .unwrap();
                            out.write_all(&ack).unwrap();
                            out.write_all(b"\r\n").unwrap();
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    port
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn health(port: u16) -> Option<u16> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        s,
        "GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).ok()?;
    raw.split_whitespace().nth(1)?.parse().ok()
}

fn locked(path: &Path) -> bool {
    matches!(FileJournal::open(path), Err(JournalError::Locked { .. }))
}

#[test]
fn two_signals_share_one_drain_and_cannot_close_the_journal_before_http_drains() {
    let dir = temp_dir("matching-drain-native-");
    let path = dir.join("journal").join("engine.ndjson");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    {
        let mut writer = live(&path, Bus::default());
        assert!(
            writer
                .submit(MARKET, &order(61, "maker", Side::Sell), None)
                .unwrap()
                .accepted
        );
    }
    let journal_before = fs::read(&path).unwrap();

    let nats = fake_nats();
    let port = free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_svc-matching"))
        .env_clear()
        .env("NODE_ENV", "test")
        .env("SERVICE_NAME", "svc-matching")
        .env(
            "INTERNAL_SERVICE_SECRET",
            "placeholder-matching-env-internal-secret-long",
        )
        .env("MATCHING_SNAPSHOT_EVERY", "0")
        .env(
            "MATCHING_OPERATOR_IDS",
            "11111111-1111-4111-8111-111111111111,44444444-4444-4444-8444-444444444444",
        )
        .env("MATCHING_JOURNAL_PATH", &path)
        .env("NATS_URL", format!("nats://127.0.0.1:{nats}"))
        .env("HTTP_HOST", "127.0.0.1")
        .env("HTTP_PORT", port.to_string())
        .env("LOG_LEVEL", "error")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while health(port) != Some(200) {
        assert!(
            child.try_wait().unwrap().is_none(),
            "the binary exited before it listened"
        );
        assert!(Instant::now() < deadline, "the binary never listened");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(locked(&path), "the running binary holds the journal");

    // One request in flight: its head is read, its body is not finished.
    let body = format!("{{\"orders\":[],\"pad\":\"{}\"}}", "x".repeat(2048));
    let mut held = TcpStream::connect(("127.0.0.1", port)).unwrap();
    held.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(
        held,
        "POST /reconcile HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        &body[..16]
    )
    .unwrap();
    held.flush().unwrap();
    std::thread::sleep(Duration::from_millis(400));

    let pid = rustix::process::Pid::from_child(&child);
    rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
    rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
    rustix::process::kill_process(pid, rustix::process::Signal::INT).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        child.try_wait().unwrap().is_none(),
        "the process exited with a request still in flight"
    );
    assert!(
        locked(&path),
        "the journal was closed before the request in flight was answered"
    );

    held.write_all(&body.as_bytes()[16..]).unwrap();
    held.flush().unwrap();
    let mut raw = String::new();
    held.read_to_string(&mut raw).unwrap();
    let status: u16 = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no answer to the request in flight: {raw:?}"));
    // Unsigned, so refused: what matters is that it was answered at all.
    assert_eq!(status, 401, "{raw}");

    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "the signals did not drain the binary"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(exit.code(), Some(0), "one drain, one clean exit");
    assert!(!locked(&path), "the drain released the journal");
    assert_eq!(fs::read(&path).unwrap(), journal_before);
    let _ = fs::remove_dir_all(&dir);
}
