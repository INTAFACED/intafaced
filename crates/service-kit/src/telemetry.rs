//! Tracing and logs.
//!
//! Tracing (`@intafaced/telemetry` `startTelemetry`): with `OTEL_ENABLED`, each request becomes one server span, batched
//! and sent as OTLP/HTTP JSON to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` with the service name and environment on the
//! resource; an incoming `traceparent` is continued. An export that fails is logged at warn, never silent, and never
//! stops the service. Shutdown flushes what is queued (`registerProcessHooks`). Off: nothing is started.
//!
//! Logs: one JSON line per event in pino's shape (`level` number, `time`, `pid`, `hostname`, `msg`), as Fastify's
//! logger writes them, at or above `LOG_LEVEL`.

use std::io::Write as _;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::http::{Fetch, HttpRequest};
use crate::json::Json;

/// pino's level numbers.
pub fn level_number(name: &str) -> u8 {
    match name {
        "fatal" => 60,
        "error" => 50,
        "warn" => 40,
        "debug" => 20,
        "trace" => 10,
        _ => 30,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// A pino-shaped JSON logger.
#[derive(Clone)]
pub struct Logger {
    min: u8,
    base: Vec<(String, Json)>,
    out: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

impl Logger {
    pub fn new(level: &str, out: Box<dyn std::io::Write + Send>) -> Logger {
        let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
            .map(|h| h.trim().to_owned())
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default();
        Logger {
            min: level_number(level),
            base: vec![
                ("pid".to_owned(), Json::int(i64::from(std::process::id()))),
                ("hostname".to_owned(), Json::str(hostname)),
            ],
            out: Arc::new(Mutex::new(out)),
        }
    }

    pub fn stdout(level: &str) -> Logger {
        Logger::new(level, Box::new(std::io::stdout()))
    }

    pub fn log(&self, level: &str, fields: Vec<(&str, Json)>, msg: &str) {
        let n = level_number(level);
        if n < self.min {
            return;
        }
        let mut line = vec![
            ("level".to_owned(), Json::int(i64::from(n))),
            ("time".to_owned(), Json::int(now_ms())),
        ];
        line.extend(self.base.iter().cloned());
        line.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
        line.push(("msg".to_owned(), Json::str(msg)));
        let text = Json::Object(line).compact();
        if let Ok(mut out) = self.out.lock() {
            let _ = writeln!(out, "{text}");
            let _ = out.flush();
        }
    }

    pub fn info(&self, fields: Vec<(&str, Json)>, msg: &str) {
        self.log("info", fields, msg);
    }

    pub fn warn(&self, fields: Vec<(&str, Json)>, msg: &str) {
        self.log("warn", fields, msg);
    }

    pub fn error(&self, fields: Vec<(&str, Json)>, msg: &str) {
        self.log("error", fields, msg);
    }
}

/// One finished server span.
#[derive(Debug, Clone)]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub start_nanos: u128,
    pub end_nanos: u128,
    pub method: String,
    pub path: String,
    pub status: u16,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    if getrandom::fill(&mut b).is_err() {
        // No randomness: a fixed id still exports, and only correlation is lost.
        b.fill(1);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A W3C `traceparent`: `00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`; ids all-zero are invalid.
fn parse_traceparent(v: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = v.trim().split('-').collect();
    let [version, trace, parent, flags] = parts.as_slice() else {
        return None;
    };
    let hex = |s: &str, n: usize| {
        s.len() == n
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !hex(version, 2) || *version == "ff" || !hex(trace, 32) || !hex(parent, 16) || !hex(flags, 2)
    {
        return None;
    }
    if trace.bytes().all(|b| b == b'0') || parent.bytes().all(|b| b == b'0') {
        return None;
    }
    Some(((*trace).to_owned(), (*parent).to_owned()))
}

/// A span being timed.
pub struct Started {
    trace_id: String,
    parent: Option<String>,
    start: u128,
}

impl Started {
    pub fn begin(traceparent: Option<&str>) -> Started {
        let (trace_id, parent) = match traceparent.and_then(parse_traceparent) {
            Some((t, p)) => (t, Some(p)),
            None => (random_hex(16), None),
        };
        Started {
            trace_id,
            parent,
            start: now_nanos(),
        }
    }

    pub fn end(self, method: &str, path: &str, status: u16) -> Span {
        Span {
            trace_id: self.trace_id,
            span_id: random_hex(8),
            parent_span_id: self.parent,
            name: format!("{method} {path}"),
            start_nanos: self.start,
            end_nanos: now_nanos(),
            method: method.to_owned(),
            path: path.to_owned(),
            status,
        }
    }
}

/// The OTLP/HTTP JSON body for a batch of spans.
pub fn otlp_body(service: &str, environment: &str, spans: &[Span]) -> String {
    let attr = |k: &str, v: Json| Json::obj([("key", Json::str(k)), ("value", v)]);
    let s = |v: &str| Json::obj([("stringValue", Json::str(v))]);
    let int = |v: i64| Json::obj([("intValue", Json::str(v.to_string()))]);
    let spans: Vec<Json> = spans
        .iter()
        .map(|sp| {
            let mut fields = vec![
                ("traceId".to_owned(), Json::str(sp.trace_id.clone())),
                ("spanId".to_owned(), Json::str(sp.span_id.clone())),
            ];
            if let Some(p) = &sp.parent_span_id {
                fields.push(("parentSpanId".to_owned(), Json::str(p.clone())));
            }
            fields.extend([
                ("name".to_owned(), Json::str(sp.name.clone())),
                // SPAN_KIND_SERVER
                ("kind".to_owned(), Json::int(2)),
                (
                    "startTimeUnixNano".to_owned(),
                    Json::str(sp.start_nanos.to_string()),
                ),
                (
                    "endTimeUnixNano".to_owned(),
                    Json::str(sp.end_nanos.to_string()),
                ),
                (
                    "attributes".to_owned(),
                    Json::Array(vec![
                        attr("http.request.method", s(&sp.method)),
                        attr("url.path", s(&sp.path)),
                        attr("http.response.status_code", int(i64::from(sp.status))),
                    ]),
                ),
                (
                    "status".to_owned(),
                    // STATUS_CODE_ERROR for a server error, else UNSET.
                    Json::obj([("code", Json::int(if sp.status >= 500 { 2 } else { 0 }))]),
                ),
            ]);
            Json::Object(fields)
        })
        .collect();
    Json::obj([(
        "resourceSpans",
        Json::Array(vec![Json::obj([
            (
                "resource",
                Json::obj([(
                    "attributes",
                    Json::Array(vec![
                        attr("service.name", s(service)),
                        attr("deployment.environment.name", s(environment)),
                    ]),
                )]),
            ),
            (
                "scopeSpans",
                Json::Array(vec![Json::obj([
                    ("scope", Json::obj([("name", Json::str(service))])),
                    ("spans", Json::Array(spans)),
                ])]),
            ),
        ])]),
    )])
    .compact()
}

const BATCH: usize = 512;
const FLUSH_EVERY: Duration = Duration::from_secs(5);

/// The span exporter. `None` inside when tracing is off.
pub struct Telemetry {
    sender: Mutex<Option<Sender<Span>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Telemetry {
    /// `startTelemetry({ serviceName, endpoint, enabled, environment })`.
    pub fn start(
        enabled: bool,
        service: &str,
        endpoint: &str,
        environment: &str,
        fetch: Arc<dyn Fetch>,
        log: Logger,
    ) -> Telemetry {
        if !enabled {
            return Telemetry {
                sender: Mutex::new(None),
                worker: Mutex::new(None),
            };
        }
        let url = format!("{}/v1/traces", endpoint.trim_end_matches('/'));
        let (tx, rx) = channel::<Span>();
        let (service, environment) = (service.to_owned(), environment.to_owned());
        let worker = std::thread::spawn(move || {
            export_loop(&rx, &url, &service, &environment, fetch.as_ref(), &log)
        });
        Telemetry {
            sender: Mutex::new(Some(tx)),
            worker: Mutex::new(Some(worker)),
        }
    }

    pub fn enabled(&self) -> bool {
        self.sender.lock().is_ok_and(|s| s.is_some())
    }

    pub fn record(&self, span: Span) {
        if let Ok(guard) = self.sender.lock()
            && let Some(tx) = guard.as_ref()
        {
            let _ = tx.send(span);
        }
    }

    /// Flushes what is queued and stops. Safe to call more than once.
    pub fn shutdown(&self) {
        if let Ok(mut s) = self.sender.lock() {
            s.take();
        }
        let worker = self.worker.lock().ok().and_then(|mut w| w.take());
        if let Some(w) = worker {
            let _ = w.join();
        }
    }
}

fn export_loop(
    rx: &Receiver<Span>,
    url: &str,
    service: &str,
    environment: &str,
    fetch: &dyn Fetch,
    log: &Logger,
) {
    let mut batch: Vec<Span> = Vec::new();
    let send = |batch: &mut Vec<Span>| {
        if batch.is_empty() {
            return;
        }
        let res = fetch.fetch(&HttpRequest {
            method: "POST".to_owned(),
            url: url.to_owned(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some(otlp_body(service, environment, batch)),
            timeout_ms: Some(10_000),
            refuse_redirect: false,
        });
        match res {
            Ok(r) if r.ok() => {}
            Ok(r) => log.warn(
                vec![("status", Json::int(i64::from(r.status)))],
                "telemetry export failed",
            ),
            Err(e) => log.warn(
                vec![("err", Json::str(e.message))],
                "telemetry export failed",
            ),
        }
        batch.clear();
    };
    loop {
        match rx.recv_timeout(FLUSH_EVERY) {
            Ok(span) => {
                batch.push(span);
                if batch.len() >= BATCH {
                    send(&mut batch);
                }
            }
            Err(RecvTimeoutError::Timeout) => send(&mut batch),
            Err(RecvTimeoutError::Disconnected) => {
                send(&mut batch);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continues_a_valid_traceparent_and_starts_a_trace_otherwise() {
        let s = Started::begin(Some(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        ));
        let span = s.end("GET", "/health", 200);
        assert_eq!(span.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(span.parent_span_id.as_deref(), Some("00f067aa0ba902b7"));
        let fresh = Started::begin(Some(
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        ))
        .end("GET", "/", 404);
        assert_eq!(fresh.trace_id.len(), 32);
        assert!(fresh.parent_span_id.is_none());
        let body = otlp_body("svc-tax", "dev", &[span]);
        assert!(body.contains(r#""service.name","value":{"stringValue":"svc-tax"}"#));
        assert!(body.contains(r#""name":"GET /health""#));
    }
}
