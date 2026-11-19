//! The HTTP server (a TypeScript service's `index.ts` Fastify app): `GET /health`, `GET /ready`, and `/trpc/*` through
//! the service's door (any `Door`: svc-tax's is its `Wire`). Fastify answers HEAD for every GET route and gives every
//! request the next request id, whatever its route; both are kept. A fixed set of worker threads takes requests; on
//! SIGTERM or SIGINT the server stops taking new ones, lets those in flight finish, then the caller closes the pool and
//! flushes tracing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant as Clock};

use crate::json::Json;
use crate::telemetry::{Logger, Started, Telemetry};

/// One HTTP request as it reaches the service.
pub struct Request<'a> {
    pub method: &'a str,
    /// The path and query, as sent (`/trpc/lotBook?input=...`).
    pub url: &'a str,
    /// Header names in lower case.
    pub headers: &'a [(String, String)],
    pub body: &'a str,
}

/// The answer: status and body. The body is always JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// A service's door: what answers every request that is not `/health` or `/ready`.
pub trait Door: Sync {
    /// The next Fastify request id. The server takes one for every request, whatever its route.
    fn next_request_id(&self) -> String;
    /// Answers one request under the id the server already gave it.
    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response;
    /// Answers one request from the TCP peer `peer` (Fastify's `req.ip`: the socket's address, blank when unknown). A
    /// door that never reads the caller's address answers as `handle_as`.
    fn handle_from(&self, req: &Request<'_>, request_id: &str, peer: &str) -> Response {
        let _ = peer;
        self.handle_as(req, request_id)
    }
}

/// Fastify's request ids: `req-1`, `req-2`, ... in base 36, one per request this process takes.
#[derive(Debug, Default)]
pub struct RequestIds(AtomicU64);

impl RequestIds {
    pub fn new() -> RequestIds {
        RequestIds(AtomicU64::new(0))
    }

    /// The next id.
    pub fn next(&self) -> String {
        let mut n = self.0.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        let mut digits = Vec::new();
        while n > 0 {
            digits.push(char::from_digit(u32::try_from(n % 36).unwrap_or(0), 36).unwrap_or('0'));
            n /= 36;
        }
        format!("req-{}", digits.iter().rev().collect::<String>())
    }
}

/// Requests served at once.
pub const WORKERS: usize = 16;

/// One answer: status, content type, body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

/// What the routes need.
pub struct App<D: Door> {
    pub wire: D,
    pub service_name: String,
    pub ready_body: String,
}

const FASTIFY_JSON: &str = "application/json; charset=utf-8";

impl<D: Door> App<D> {
    /// Routes one request, as Fastify would. `request_id` is already taken.
    pub fn route(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        request_id: &str,
    ) -> Answer {
        self.route_from(method, url, headers, body, request_id, "")
    }

    /// Routes one request from the TCP peer `peer`, as Fastify would.
    pub fn route_from(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        request_id: &str,
        peer: &str,
    ) -> Answer {
        let path = url.split_once('?').map_or(url, |(p, _)| p);
        let json = |status: u16, body: String| Answer {
            status,
            content_type: FASTIFY_JSON,
            body,
        };
        if matches!(method, "GET" | "HEAD") {
            if path == "/health" {
                let body = Json::obj([
                    ("ok", Json::Bool(true)),
                    ("service", Json::str(self.service_name.clone())),
                ]);
                return json(200, body.compact());
            }
            if path == "/ready" {
                return json(200, self.ready_body.clone());
            }
        }
        let res = self.wire.handle_from(
            &Request {
                method,
                url,
                headers,
                body,
            },
            request_id,
            peer,
        );
        Answer {
            status: res.status,
            content_type: if path.starts_with("/trpc/") {
                "application/json"
            } else {
                FASTIFY_JSON
            },
            body: res.body,
        }
    }
}

/// Serves until `stop` is set, then returns once every worker has finished its request.
pub fn serve<D: Door>(
    server: &tiny_http::Server,
    app: &App<D>,
    log: &Logger,
    telemetry: &Telemetry,
    stop: &Arc<AtomicBool>,
) {
    std::thread::scope(|s| {
        for _ in 0..WORKERS {
            s.spawn(|| {
                while !stop.load(Ordering::SeqCst) {
                    match server.recv_timeout(Duration::from_millis(200)) {
                        Ok(Some(req)) => answer(req, app, log, telemetry),
                        Ok(None) => {}
                        Err(e) => {
                            log.error(vec![("err", Json::str(e.to_string()))], "accept failed");
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });
        }
    });
}

fn answer<D: Door>(mut req: tiny_http::Request, app: &App<D>, log: &Logger, telemetry: &Telemetry) {
    let started = Clock::now();
    let request_id = app.wire.next_request_id();
    let method = req.method().as_str().to_owned();
    let url = req.url().to_owned();
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_ascii_lowercase(),
                h.value.as_str().to_owned(),
            )
        })
        .collect();
    let remote = req
        .remote_addr()
        .map(ToString::to_string)
        .unwrap_or_default();
    log.info(
        vec![
            ("reqId", Json::str(request_id.clone())),
            (
                "req",
                Json::obj([
                    ("method", Json::str(method.clone())),
                    ("url", Json::str(url.clone())),
                    ("remoteAddress", Json::str(remote)),
                ]),
            ),
        ],
        "incoming request",
    );
    let traceparent = headers
        .iter()
        .find(|(k, _)| k == "traceparent")
        .map(|(_, v)| v.clone());
    let span = telemetry
        .enabled()
        .then(|| Started::begin(traceparent.as_deref()));
    let mut bytes = Vec::new();
    let _ = req.as_reader().read_to_end(&mut bytes);
    let body = String::from_utf8_lossy(&bytes);
    let peer = req
        .remote_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let out = app.route_from(&method, &url, &headers, &body, &request_id, &peer);
    let status = out.status;
    let content = if method == "HEAD" {
        Vec::new()
    } else {
        out.body.clone().into_bytes()
    };
    let mut response = tiny_http::Response::from_data(content).with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes("content-type", out.content_type) {
        response = response.with_header(h);
    }
    if method == "HEAD"
        && let Ok(h) = tiny_http::Header::from_bytes("content-length", out.body.len().to_string())
    {
        response = response.with_header(h);
    }
    if let Err(e) = req.respond(response) {
        log.warn(
            vec![
                ("reqId", Json::str(request_id.clone())),
                ("err", Json::str(e.to_string())),
            ],
            "response not sent",
        );
    }
    if let Some(span) = span {
        let path = url.split_once('?').map_or(url.as_str(), |(p, _)| p);
        telemetry.record(span.end(&method, path, status));
    }
    let ms = started.elapsed().as_secs_f64();
    #[expect(
        clippy::float_arithmetic,
        reason = "a log line's response time, not money"
    )]
    let ms = ms * 1000.0;
    log.info(
        vec![
            ("reqId", Json::str(request_id)),
            (
                "res",
                Json::obj([("statusCode", Json::int(i64::from(status)))]),
            ),
            ("responseTime", Json::Number(ms)),
        ],
        "request completed",
    );
}
