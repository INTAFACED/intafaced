//! The binary itself, as `index.ts` runs: started on a journal holding one resting order, against a stand-in NATS and
//! with no `LEDGER_URL`, it replays the journal, fails the hold check closed, and listens; `/health`, `/ready` and
//! `/metrics` answer from the live engine; SIGTERM drains it, it exits 0, and the journal's writer lock is free again.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use svc_matching::book::types::{EngineOrder, OrderType, Side, Tif};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::FileJournal;
use svc_matching::journal::replay::MemorySnapshotSink;

/// A stand-in NATS: `INFO`, a `PONG` for every `PING`, and a JetStream answer for every request with a reply subject.
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

fn clock() -> i64 {
    1_767_225_600_000
}

/// One GET: status, content type and body.
fn get(port: u16, path: &str) -> Option<(u16, String, String)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).ok()?;
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let content_type = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-type: ")
                .map(str::to_owned)
        })
        .unwrap_or_default();
    Some((status, content_type, body.to_owned()))
}

#[test]
fn the_binary_replays_fails_the_hold_check_closed_serves_its_state_and_drains_on_sigterm() {
    let dir = std::env::temp_dir().join(format!("matching-binary-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("journal").join("engine.ndjson");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    {
        let mut writer = MatchingEngine::new(EngineParts {
            journal: Box::new(FileJournal::open(&path).unwrap()),
            bus: Box::new(MemoryEventBus::default()),
            clock,
            expiry_clock: true,
            snapshot_every: 0,
            sink: Box::new(MemorySnapshotSink::default()),
            enabled: true,
            spread_fills: true,
        });
        let rest = EngineOrder::new(
            "11111111-1111-4111-8111-111111111111",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            OrderType::Limit,
            Side::Buy,
            parse_amount("1").unwrap(),
            Some(parse_amount("100").unwrap()),
            Tif::Gtc,
        );
        assert!(writer.submit("BTC-USDT", &rest, None).unwrap().accepted);
    }

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
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let health = loop {
        if let Some(answer) = get(port, "/health") {
            break answer;
        }
        if let Some(status) = child.try_wait().unwrap() {
            let mut err = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut err)
                .unwrap();
            panic!("the binary exited {status} before it listened: {err}");
        }
        assert!(Instant::now() < deadline, "the binary never listened");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(health.0, 200);
    let body = json::parse(&health.2).unwrap();
    assert_eq!(body.get("service"), Some(&Json::str("svc-matching")));
    assert_eq!(body.get("enabled"), Some(&Json::Bool(false)));
    assert_eq!(body.get("restingOrders"), Some(&Json::int(1)));
    assert_eq!(body.get("journalRecords"), Some(&Json::int(1)));
    assert_eq!(body.get("admissionOpen"), Some(&Json::Bool(false)));
    assert_eq!(
        body.get("admissionReason"),
        Some(&Json::str("matching.hold_check_unwired"))
    );
    assert!(body.get("metrics").is_some());

    let ready = get(port, "/ready").unwrap();
    // With the custody switch off, `MATCHING_ENGINE_ENABLED` follows it off: readiness names the engine flag first.
    assert_eq!(ready.0, 503);
    assert_eq!(
        ready.2,
        r#"{"ready":false,"reason":"matching.engine flag is off"}"#
    );

    let metrics = get(port, "/metrics").unwrap();
    assert_eq!(metrics.0, 200);
    assert!(
        metrics.1.starts_with("text/plain; version=0.0.4"),
        "{}",
        metrics.1
    );
    assert!(
        metrics.2.contains(r#"service="svc-matching""#),
        "{}",
        metrics.2
    );

    // While it runs, the journal has one writer.
    assert!(FileJournal::open(&path).is_err());

    let pid = rustix::process::Pid::from_child(&child);
    rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "SIGTERM did not drain the binary"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.code(), Some(0));
    assert!(
        FileJournal::open(&path).is_ok(),
        "the drain released the journal"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
