//! `GET /metrics` on the Rust binary's server, as `services/svc-ledger/src/metrics.ts` serves it: the TypeScript's
//! `metrics.test.ts`, `metrics.boot.e2e.test.ts` and `observability-wiring.test.ts`, case for case, every request sent
//! over a real socket to the kit's server (`service_kit::server::serve`, the loop the binary runs), and every body read
//! back through a strict reader of the exposition grammar (`@intafaced/telemetry` `parseExposition`).
//!
//! `tests/fixtures/metrics-route.golden.json` (`scripts/record-metrics.mjs`) holds what the TypeScript route answered:
//! each scrape byte for byte, with the reconciliation gauges over recorded reads, a read that throws and none; and the
//! counts a sequence of requests leaves. The kit's exposition is held to `@intafaced/telemetry` in
//! `crates/service-kit/tests/metrics_golden.rs`. The gauges read from a real book are in `tests/store_pg.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use service_kit::json::{self, Json};
use service_kit::metrics::{
    EMITTED_LABEL_NAMES, GaugeSample, METRICS_PATH, MODULE_LOCAL, Metrics, PROMETHEUS_CONTENT_TYPE,
    REQUEST_DURATION_SECONDS, REQUESTS_TOTAL,
};
use service_kit::s2s::system_seconds;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::{self, App, Door, Request, RequestIds, Response};
use service_kit::telemetry::{Logger, Telemetry};
use service_kit::tokens::TokenConfig;
use svc_ledger::db::Store;
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::metrics::reconcile_gauges;
use svc_ledger::reconcile::LastVerified;

use crate::support;

// ---- the reader: `parseExposition`, strict, every line parses or it fails ----

#[derive(Debug, Clone)]
struct Sample {
    name: String,
    labels: BTreeMap<String, String>,
    value: f64,
}

#[derive(Debug, Default)]
struct Parsed {
    help: BTreeMap<String, String>,
    kind: BTreeMap<String, String>,
    samples: Vec<Sample>,
}

fn is_name(s: &str, colon: bool) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || (colon && c == ':'))
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || (colon && c == ':'))
}

fn parse_labels(block: &str) -> BTreeMap<String, String> {
    let inner = &block[1..block.len() - 1];
    let mut labels = BTreeMap::new();
    let mut rest = inner;
    while !rest.is_empty() {
        let (name, after) = rest
            .split_once("=\"")
            .unwrap_or_else(|| panic!("unparseable label block: {block}"));
        assert!(is_name(name, false), "unparseable label block: {block}");
        let mut value = String::new();
        let mut chars = after.char_indices();
        let end = loop {
            match chars.next() {
                Some((i, '"')) => break i,
                Some((_, '\\')) => match chars.next() {
                    Some((_, 'n')) => value.push('\n'),
                    Some((_, c)) => value.push(c),
                    None => panic!("unparseable label block: {block}"),
                },
                Some((_, c)) => value.push(c),
                None => panic!("unparseable label block: {block}"),
            }
        };
        labels.insert(name.to_owned(), value);
        rest = &after[end + 1..];
        if let Some(next) = rest.strip_prefix(',') {
            assert!(!next.is_empty(), "unparseable label block: {block}");
            rest = next;
        } else {
            assert!(rest.is_empty(), "unparseable label block: {block}");
        }
    }
    labels
}

fn parse_exposition(text: &str) -> Parsed {
    assert!(text.ends_with('\n'), "exposition must end with a newline");
    let mut out = Parsed::default();
    for line in text[..text.len() - 1].split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# HELP ") {
            let (name, help) = rest
                .split_once(' ')
                .unwrap_or_else(|| panic!("malformed HELP line: {line}"));
            out.help.insert(name.to_owned(), help.to_owned());
            continue;
        }
        if let Some(rest) = line.strip_prefix("# TYPE ") {
            let parts: Vec<&str> = rest.split(' ').collect();
            assert!(
                parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty(),
                "malformed TYPE line: {line}"
            );
            out.kind.insert(parts[0].to_owned(), parts[1].to_owned());
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let name_end = line.find(['{', ' ']).unwrap_or(line.len());
        let name = &line[..name_end];
        assert!(is_name(name, true), "unparseable sample line: {line}");
        let (labels, raw) = if line[name_end..].starts_with('{') {
            let close = line
                .rfind("} ")
                .unwrap_or_else(|| panic!("unparseable sample line: {line}"));
            (parse_labels(&line[name_end..=close]), &line[close + 2..])
        } else {
            (BTreeMap::new(), &line[name_end + 1..])
        };
        assert!(!raw.is_empty(), "unparseable sample line: {line}");
        let value = match raw {
            "+Inf" => f64::INFINITY,
            "-Inf" => f64::NEG_INFINITY,
            "NaN" => f64::NAN,
            _ => raw
                .parse()
                .unwrap_or_else(|_| panic!("unparseable sample value: {raw}")),
        };
        out.samples.push(Sample {
            name: name.to_owned(),
            labels,
            value,
        });
    }
    out
}

// ---- the server: the kit's `serve` loop on a real socket ----

struct Reply {
    status: u16,
    content_type: String,
    body: String,
}

fn send(addr: &str, method: &str, url: &str) -> Reply {
    let mut s = TcpStream::connect(addr).unwrap();
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: svc-ledger\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let content_type = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.trim().to_owned())
        .unwrap_or_default();
    Reply {
        status,
        content_type,
        body: body.to_owned(),
    }
}

/// Runs `app` on a real port with the binary's loop, hands `f` its address, then stops the server.
fn served<D: Door, T>(app: &App<D>, f: impl FnOnce(&str) -> T) -> T {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap().to_string();
    let log = Logger::new("fatal", Box::new(std::io::sink()));
    let telemetry = Telemetry::start(
        false,
        "svc-ledger",
        "",
        "test",
        Arc::new(service_kit::http::UreqFetch::new()),
        log.clone(),
    );
    let stop = Arc::new(AtomicBool::new(false));
    // Stops the server when `f` returns or fails, so a failed assertion fails the test instead of hanging it.
    struct Stop<'a>(&'a AtomicBool);
    impl Drop for Stop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    std::thread::scope(|scope| {
        scope.spawn(|| server::serve(&server, app, &log, &telemetry, &stop));
        let _stop = Stop(&stop);
        f(&addr)
    })
}

fn scrape(addr: &str) -> (Reply, Parsed) {
    let res = send(addr, "GET", METRICS_PATH);
    assert_eq!(res.status, 200);
    let parsed = parse_exposition(&res.body);
    (res, parsed)
}

fn counters(parsed: &Parsed) -> Vec<&Sample> {
    parsed
        .samples
        .iter()
        .filter(|s| s.name == REQUESTS_TOTAL)
        .collect()
}

fn label<'a>(s: &'a Sample, name: &str) -> &'a str {
    s.labels.get(name).map_or("", String::as_str)
}

// ---- `metrics.test.ts`' app: `registerMetrics`, `/health` and a handler that throws ----

/// What a gauge read answers for this door.
enum Gauges {
    None,
    Throws,
    Last(LastVerified),
}

/// `metrics.test.ts`' `ledger()`: metrics on, `/health` (the server's own answer), `/boom` throwing, nothing else.
struct TestDoor {
    ids: RequestIds,
    metrics: Metrics,
    gauges: Gauges,
}

impl TestDoor {
    fn new(gauges: Gauges) -> TestDoor {
        TestDoor {
            ids: RequestIds::new(),
            metrics: Metrics::default(),
            gauges,
        }
    }
}

impl Door for TestDoor {
    fn next_request_id(&self) -> String {
        self.ids.next()
    }

    fn handle_as(&self, req: &Request<'_>, _request_id: &str) -> Response {
        let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
        if req.method == "GET" && path == "/boom" {
            return Response {
                status: 500,
                body: r#"{"statusCode":500,"error":"Internal Server Error","message":"handler exploded"}"#.to_owned(),
            };
        }
        Response {
            status: 404,
            body: "{}".to_owned(),
        }
    }

    fn metrics(&self) -> Option<&Metrics> {
        Some(&self.metrics)
    }

    fn gauges(&self) -> Result<Vec<GaugeSample>, String> {
        match &self.gauges {
            Gauges::None => Ok(Vec::new()),
            Gauges::Throws => Err("reconcile_runs unreadable".to_owned()),
            Gauges::Last(last) => Ok(reconcile_gauges(last)),
        }
    }
}

fn ledger() -> App<TestDoor> {
    App {
        wire: TestDoor::new(Gauges::None),
        service_name: "svc-ledger".to_owned(),
        ready_body: String::new(),
    }
}

#[test]
fn is_mounted_and_answers_with_the_prometheus_text_content_type() {
    served(&ledger(), |addr| {
        let (res, _) = scrape(addr);
        assert_eq!(res.content_type, PROMETHEUS_CONTENT_TYPE);
    });
}

#[test]
fn returns_a_body_the_exposition_grammar_accepts_before_any_traffic() {
    served(&ledger(), |addr| {
        let (_, parsed) = scrape(addr);
        assert_eq!(parsed.kind[REQUESTS_TOTAL], "counter");
        assert_eq!(parsed.kind[REQUEST_DURATION_SECONDS], "histogram");
    });
}

#[test]
fn emits_the_duration_series_a_scrape_of_ledger_metrics_must_contain() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/health");
        let (res, parsed) = scrape(addr);
        assert!(res.body.contains(REQUEST_DURATION_SECONDS));
        assert_eq!(parsed.kind[REQUEST_DURATION_SECONDS], "histogram");
        let count = parsed
            .samples
            .iter()
            .find(|s| s.name == format!("{REQUEST_DURATION_SECONDS}_count"))
            .unwrap();
        assert!(count.value >= 1.0);
        assert_eq!(label(count, "service"), "svc-ledger");
        assert_eq!(label(count, "module"), MODULE_LOCAL);
    });
}

#[test]
fn counts_a_local_request_under_local_method_and_status_class() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/health");
        let (_, parsed) = scrape(addr);
        let health = counters(&parsed)
            .into_iter()
            .find(|s| {
                label(s, "module") == MODULE_LOCAL
                    && label(s, "method") == "GET"
                    && label(s, "status") == "2xx"
            })
            .unwrap();
        assert!(health.value >= 1.0);
        assert_eq!(label(health, "service"), "svc-ledger");
        assert_eq!(label(health, "outcome"), "none");
    });
}

#[test]
fn emits_a_histogram_with_real_observations_not_an_empty_declaration() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/health");
        send(addr, "GET", "/health");
        let (_, parsed) = scrape(addr);
        let of = |suffix: &str, le: Option<&str>| -> Vec<&Sample> {
            parsed
                .samples
                .iter()
                .filter(|s| {
                    s.name == format!("{REQUEST_DURATION_SECONDS}{suffix}")
                        && label(s, "module") == MODULE_LOCAL
                        && label(s, "method") == "GET"
                        && label(s, "status") == "2xx"
                        && le.is_none_or(|le| label(s, "le") == le)
                })
                .collect()
        };
        // Two `/health`s; the scrape itself is observed after its body is rendered.
        assert_eq!(of("_count", None)[0].value, 2.0);
        assert_eq!(of("_bucket", Some("+Inf"))[0].value, 2.0);
        let sum = of("_sum", None)[0].value;
        assert!(sum >= 0.0 && sum.is_finite());
        let values: Vec<f64> = of("_bucket", None).iter().map(|b| b.value).collect();
        assert!(values.len() > 1);
        for pair in values.windows(2) {
            assert!(pair[1] >= pair[0], "{values:?}");
        }
    });
}

#[test]
fn counts_failures_the_requests_an_availability_number_exists_to_see() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/boom");
        let (_, parsed) = scrape(addr);
        let boom = counters(&parsed)
            .into_iter()
            .find(|s| label(s, "status") == "5xx")
            .unwrap();
        assert_eq!(label(boom, "module"), MODULE_LOCAL);
        assert_eq!(boom.value, 1.0);
    });
}

#[test]
fn labels_every_path_local_rather_than_inventing_a_module_from_the_url() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/health");
        send(addr, "GET", "/operator/freeze");
        send(addr, "POST", "/trpc/post");
        scrape(addr);
        let (_, parsed) = scrape(addr);
        let modules: std::collections::BTreeSet<&str> = counters(&parsed)
            .iter()
            .map(|s| label(s, "module"))
            .collect();
        assert!(!modules.is_empty());
        for m in modules {
            assert_eq!(m, MODULE_LOCAL);
        }
    });
}

#[test]
fn does_not_carry_a_query_string_into_a_label() {
    served(&ledger(), |addr| {
        send(addr, "GET", "/health?owner=alice&cursor=abc");
        let (res, _) = scrape(addr);
        assert!(!res.body.contains("alice"));
        assert!(!res.body.contains("cursor"));
    });
}

/// `moduleLabel` is always `_local`: whatever path a request names, its observation's module is `_local` (the
/// server's one observe, `App::observe`, takes no path at all).
#[test]
fn module_label_is_always_local_ledger_is_not_a_proxy() {
    let app = ledger();
    for path in [
        "/health",
        "/ready",
        METRICS_PATH,
        "/operator/freeze",
        "/trpc/post",
        "/api/ledger/balance",
    ] {
        let answer = app.route("GET", path, &[], "", "req-1");
        app.observe("GET", answer.status, std::time::Duration::ZERO);
    }
    let parsed = parse_exposition(&app.wire.metrics.render());
    for s in counters(&parsed) {
        assert_eq!(label(s, "module"), MODULE_LOCAL);
    }
    assert_eq!(counters(&parsed).iter().map(|s| s.value).sum::<f64>(), 6.0);
}

// ---- the TypeScript's own answers, recorded ----

fn golden() -> Json {
    json::parse(include_str!("fixtures/metrics-route.golden.json")).unwrap()
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn list<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key}: {other:?}"),
    }
}

#[test]
fn every_recorded_scrape_matches_the_typescript_byte_for_byte() {
    let g = golden();
    let scrapes = list(&g, "scrapes");
    assert_eq!(scrapes.len(), 7);
    for c in scrapes {
        let name = text(c, "name");
        let gauges = match c.get("last") {
            Some(Json::String(s)) if s == "throws" => Gauges::Throws,
            Some(Json::String(s)) if s == "none" => Gauges::None,
            Some(last) => Gauges::Last(LastVerified {
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "a recorded millisecond time"
                )]
                at_ms: match last.get("atMs") {
                    Some(Json::Number(n)) => Some(*n as i64),
                    _ => None,
                },
                seq: match last.get("seq") {
                    Some(Json::String(s)) => Some(s.clone()),
                    _ => None,
                },
                first_attempt_ms: None,
            }),
            None => panic!("{name}: last"),
        };
        let app = App {
            wire: TestDoor::new(gauges),
            service_name: text(c, "service"),
            ready_body: String::new(),
        };
        served(&app, |addr| {
            let res = send(addr, "GET", METRICS_PATH);
            assert_eq!(
                Json::Number(f64::from(res.status)),
                *c.get("status").unwrap(),
                "{name}"
            );
            assert_eq!(res.content_type, text(c, "contentType"), "{name}");
            assert_eq!(res.body, text(c, "body"), "{name}");
        });
    }
}

#[test]
fn a_recorded_sequence_of_requests_leaves_the_counts_the_typescript_left() {
    let g = golden();
    let rec = g.get("requests").unwrap();
    let app = ledger();
    served(&app, |addr| {
        for r in list(rec, "requests") {
            let res = send(addr, &text(r, "method"), &text(r, "url"));
            assert_eq!(
                Json::Number(f64::from(res.status)),
                *r.get("status").unwrap(),
                "{} {}",
                text(r, "method"),
                text(r, "url")
            );
        }
        let (res, _) = scrape(addr);
        let timeless: Vec<&str> = res
            .body
            .split('\n')
            .filter(|l| {
                !l.is_empty()
                    && (!l.starts_with("intafaced_http_request_duration_seconds_")
                        || l.contains("_count{")
                        || l.contains("le=\"+Inf\""))
            })
            .collect();
        let want: Vec<String> = list(rec, "lines")
            .iter()
            .map(|l| match l {
                Json::String(s) => s.clone(),
                _ => panic!("a line is text"),
            })
            .collect();
        assert_eq!(timeless, want);
    });
}

// ---- `metrics.boot.e2e.test.ts`: the door the binary serves has `/metrics` ----

fn ledger_door(store: Store) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        internal_secret: "placeholder-metrics-test-secret".to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        tokens: TokenConfig {
            secret: "placeholder-metrics-test-token-secret".to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store,
        service_name: "svc-ledger".to_owned(),
        bus: Arc::new(svc_ledger::freeze::MemoryBus::default()),
        approvals: Box::new(svc_ledger::approval::Unwired),
        clock_skew_bound_ms: None,
        now_ms: svc_ledger::clock::system_ms,
        log: Logger::new("fatal", Box::new(std::io::sink())),
        custody: svc_ledger::reconcile::CustodyLayer::On,
        reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
        indexer_url: None,
        fetch: Arc::new(service_kit::http::UreqFetch::new()),
        posting: support::idle_posting(),
        reconciliation_sources: Arc::new(svc_ledger::controls::sources::Unset),
    })
    .unwrap()
}

fn main_rs() -> String {
    std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/main.rs")).unwrap()
}

/// Executable lines: not `//` comments.
fn live_lines(src: &str) -> Vec<(usize, &str)> {
    src.lines()
        .enumerate()
        .filter(|(_, l)| !l.trim_start().starts_with("//"))
        .collect()
}

/// `index.ts` imports `registerMetrics`: here the door the binary builds keeps the metrics itself, so the served
/// `LedgerDoor` answers `/metrics` with no other wiring. A database read that fails leaves the gauges out, never the
/// scrape (the store here refuses every query).
#[test]
fn the_door_the_binary_serves_answers_metrics() {
    let app = App {
        wire: ledger_door(Store::Down("metrics test: no database".to_owned())),
        service_name: "svc-ledger".to_owned(),
        ready_body: String::new(),
    };
    served(&app, |addr| {
        send(addr, "POST", "/trpc/post");
        send(addr, "GET", "/nowhere");
        let (res, parsed) = scrape(addr);
        assert_eq!(res.content_type, PROMETHEUS_CONTENT_TYPE);
        assert_eq!(parsed.kind[REQUESTS_TOTAL], "counter");
        assert!(!res.body.contains("ledger_reconcile_last_verified"));
        let modules: Vec<&str> = counters(&parsed)
            .iter()
            .map(|s| label(s, "module"))
            .collect();
        assert!(!modules.is_empty());
        assert!(modules.iter().all(|m| *m == MODULE_LOCAL));
        assert!(
            counters(&parsed)
                .iter()
                .any(|s| label(s, "method") == "GET" && label(s, "status") == "4xx"),
            "{}",
            res.body
        );
    });
}

/// `calls registerMetrics(app, ...) before listen`: `main.rs` builds the served `App` from the `LedgerDoor` and runs
/// it through the kit's `serve`, the loop that observes every reply, after it binds the port.
#[test]
fn main_serves_the_ledger_door_through_the_observing_loop() {
    let src = main_rs();
    let live = live_lines(&src);
    let app = live
        .iter()
        .position(|(_, l)| l.trim() == "let app = App {")
        .expect("main.rs builds the served App on a live line");
    assert_eq!(live[app + 1].1.trim(), "wire: door,");
    let bind = live
        .iter()
        .find(|(_, l)| l.contains("tiny_http::Server::http("))
        .expect("main.rs binds the port");
    let serve = live
        .iter()
        .find(|(_, l)| l.contains("server::serve(&server, &app,"))
        .expect("main.rs serves the App through server::serve on a live line");
    assert!(live[app].0 < serve.0 && bind.0 < serve.0);
}

/// `fails if the call is commented out`: the served door's `metrics` is on.
#[test]
fn the_ledger_door_keeps_metrics() {
    let door = ledger_door(Store::Down("metrics test: no database".to_owned()));
    assert!(door.metrics().is_some());
}

// ---- `observability-wiring.test.ts`: the scrape config reaches this endpoint ----

fn read(rel: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(rel),
    )
    .unwrap()
}

/// `blockAt`: the block under `key:` at `indent` spaces.
fn block_at(text: &str, indent: usize, key: &str) -> String {
    let pad = " ".repeat(indent);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| *l == format!("{pad}{key}:") || l.starts_with(&format!("{pad}{key}: ")))
        .unwrap_or_else(|| panic!("no block \"{key}\" at indent {indent}"));
    let mut out = vec![lines[start]];
    for line in &lines[start + 1..] {
        if !line.trim().is_empty()
            && !line.starts_with(&format!("{pad} "))
            && !line.starts_with(&format!("{pad}\t"))
        {
            break;
        }
        out.push(line);
    }
    out.join("\n")
}

fn leading_spaces(l: &str) -> usize {
    l.len() - l.trim_start_matches(' ').len()
}

/// `scrapeJob`: the one `- job_name: <name>` entry.
fn scrape_job(yaml: &str, job: &str) -> String {
    let lines: Vec<&str> = yaml.lines().collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim() == format!("- job_name: {job}"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(starts.len(), 1);
    let mut out = vec![lines[starts[0]]];
    for line in &lines[starts[0] + 1..] {
        let list_item = line.trim_start_matches(' ').starts_with("- ");
        if list_item && leading_spaces(line) < 6 {
            break;
        }
        if !line.trim().is_empty() && leading_spaces(line) < 4 {
            break;
        }
        out.push(line);
    }
    out.join("\n")
}

fn job() -> String {
    scrape_job(&read("tooling/infra/prometheus.yaml"), "svc-ledger")
}

fn targets(job: &str) -> Vec<String> {
    let at = job.find("targets:").expect("targets");
    let rest = job[at + "targets:".len()..].trim_start();
    let inner = rest
        .strip_prefix('[')
        .expect("targets: [")
        .split(']')
        .next()
        .unwrap();
    inner
        .split(',')
        .map(|t| t.trim().trim_matches(['\'', '"']).to_owned())
        .collect()
}

#[test]
fn targets_the_compose_service_name_not_localhost_and_not_a_host_port() {
    let hosts = targets(&job());
    assert_eq!(hosts, vec!["svc-ledger:4001".to_owned()]);
    assert!(!hosts.join(",").contains("localhost"));
    assert!(!hosts.join(",").contains("127.0.0.1"));
}

#[test]
fn names_the_port_svc_ledger_is_actually_configured_to_listen_on() {
    let compose = read("docker-compose.apps.yml");
    let ledger = block_at(&compose, 2, "svc-ledger");
    let http_port = ledger
        .lines()
        .find_map(|l| l.trim().strip_prefix("HTTP_PORT:"))
        .map(|v| v.trim().trim_matches('\'').to_owned())
        .expect("HTTP_PORT");
    assert!(!http_port.is_empty() && http_port.chars().all(|c| c.is_ascii_digit()));
    let target = targets(&job())[0].clone();
    let (host, port) = target.split_once(':').unwrap();
    assert_eq!(port, http_port);
    assert_eq!(host, "svc-ledger");
    assert!(compose.contains(&format!("\n  {host}:\n")));
}

#[test]
fn scrapes_the_path_the_service_registers_character_for_character() {
    let job = job();
    let path = job
        .lines()
        .find_map(|l| l.trim().strip_prefix("metrics_path:"))
        .map(|v| v.split_whitespace().next().unwrap_or_default().to_owned());
    assert_eq!(path.as_deref(), Some(METRICS_PATH));
}

#[test]
fn sits_on_the_same_compose_network_as_prometheus() {
    let apps = read("docker-compose.apps.yml");
    // `/include:\s*\n\s*-\s*docker-compose\.yml/`, anywhere in the file.
    let includes = apps.match_indices("include:").any(|(at, key)| {
        let after = &apps[at + key.len()..];
        let gap = after.len() - after.trim_start().len();
        after[..gap].contains('\n')
            && after
                .trim_start()
                .strip_prefix('-')
                .is_some_and(|item| item.trim_start().starts_with("docker-compose.yml"))
    });
    assert!(
        includes,
        "docker-compose.apps.yml includes docker-compose.yml"
    );
    assert!(read("docker-compose.yml").contains("prom/prometheus"));
}

#[test]
fn adds_no_label_the_exposition_already_owns() {
    let job = job();
    for name in EMITTED_LABEL_NAMES {
        assert!(
            !job.lines()
                .any(|l| l.starts_with(' ') && l.trim_start().starts_with(&format!("{name}:"))),
            "{name}"
        );
    }
}

#[test]
fn get_metrics_contains_the_duration_family_before_any_other_traffic() {
    let app = App {
        wire: ledger_door(Store::Down("metrics test: no database".to_owned())),
        service_name: "svc-ledger".to_owned(),
        ready_body: String::new(),
    };
    served(&app, |addr| {
        let res = send(addr, "GET", METRICS_PATH);
        assert_eq!(res.status, 200);
        assert!(res.body.contains("intafaced_http_request_duration_seconds"));
    });
}
