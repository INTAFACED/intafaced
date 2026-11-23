//! The HTTP server (a TypeScript service's `index.ts` Fastify app): `GET /health`, `GET /ready`, `GET /metrics` when the
//! door keeps metrics (`Door::metrics`; every reply is then observed), and `/trpc/*` through
//! the service's door (any `Door`: svc-tax's is its `Wire`). Fastify answers HEAD for every GET route and gives every
//! request the next request id, whatever its route; both are kept. A fixed set of worker threads takes requests; on
//! SIGTERM or SIGINT the server stops taking new ones, lets those in flight finish, then the caller closes the pool and
//! flushes tracing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant as Clock};

use crate::json::Json;
use crate::metrics::{self, GaugeSample, Labels, Metrics};
use crate::telemetry::{Logger, Started, Telemetry};

/// The header the server sets to the request's TCP peer address (never the caller's own header of that name).
pub const SOCKET_PEER: &str = "x-intafaced-socket-peer";

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
    /// `GET /health` and `GET /ready` (and their HEADs), when the door answers them from its own state. `None`, the
    /// default, leaves the server's fixed answers: `{ ok, service }` and the app's `ready_body`.
    fn status(&self, req: &Request<'_>) -> Option<Response> {
        let _ = req;
        None
    }
    /// An answer that is not JSON, from the TCP peer `peer`: a page with its own content type, or a redirect, each with
    /// the headers it needs (a Fastify route's `reply.headers`). `None`, the default, sends the request on to
    /// `handle_from`.
    fn page(&self, req: &Request<'_>, peer: &str) -> Option<Answer> {
        let _ = (req, peer);
        None
    }
    /// The process's request metrics (a service's `registerMetrics`). `Some`: the server serves `GET /metrics` and
    /// observes every reply it sends there. `None`, the default: no such route, nothing observed.
    fn metrics(&self) -> Option<&Metrics> {
        None
    }
    /// The gauges appended to each scrape (`registerMetrics`' `gauges`), read on every scrape. An `Err` leaves them out:
    /// a scrape never fails because a read did.
    fn gauges(&self) -> Result<Vec<GaugeSample>, String> {
        Ok(Vec::new())
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

/// One answer: status, content type, any other headers, body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub content_type: &'static str,
    /// Headers besides the content type (`cache-control`, `location`, ...), names in lower case.
    pub headers: Vec<(&'static str, String)>,
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
            headers: Vec::new(),
            body,
        };
        if matches!(method, "GET" | "HEAD")
            && path == metrics::METRICS_PATH
            && let Some(registry) = self.wire.metrics()
        {
            // `registerMetrics`' route: the gauges read first, then the registry, in the Prometheus content type.
            let extra = self
                .wire
                .gauges()
                .map(|g| metrics::render_gauges(&g, &self.service_name))
                .unwrap_or_default();
            return Answer {
                status: 200,
                content_type: metrics::PROMETHEUS_CONTENT_TYPE,
                headers: Vec::new(),
                body: registry.render() + &extra,
            };
        }
        if matches!(method, "GET" | "HEAD") && matches!(path, "/health" | "/ready") {
            let req = Request {
                method,
                url,
                headers,
                body,
            };
            if let Some(res) = self.wire.status(&req) {
                return json(res.status, res.body);
            }
        }
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
        let req = Request {
            method,
            url,
            headers,
            body,
        };
        if let Some(page) = self.wire.page(&req, peer) {
            return page;
        }
        let res = self.wire.handle_from(&req, request_id, peer);
        Answer {
            status: res.status,
            content_type: if path.starts_with("/trpc/") {
                "application/json"
            } else {
                FASTIFY_JSON
            },
            headers: Vec::new(),
            body: res.body,
        }
    }

    /// The `onResponse` hook of a service's `metrics.ts`: one reply observed under the service's name, `module="_local"`
    /// (the service is not a proxy, so no label comes from the URL) and `outcome="none"`. Nothing when the door has no
    /// metrics.
    pub fn observe(&self, method: &str, status: u16, elapsed: Duration) {
        if let Some(registry) = self.wire.metrics() {
            registry.observe(
                &Labels {
                    service: self.service_name.clone(),
                    module: metrics::MODULE_LOCAL.to_owned(),
                    method: metrics::method_label(method),
                    status: metrics::status_class(status).to_owned(),
                    outcome: "none".to_owned(),
                },
                elapsed.as_secs_f64(),
            );
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
    let mut headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_ascii_lowercase(),
                h.value.as_str().to_owned(),
            )
        })
        .filter(|(name, _)| name != SOCKET_PEER)
        .collect();
    let remote = req
        .remote_addr()
        .map(ToString::to_string)
        .unwrap_or_default();
    // The TCP peer (`req.socket.remoteAddress`), for a door that believes a forwarded address only from a trusted
    // proxy. Set here alone: a header of that name the caller sent was dropped above.
    if let Some(peer) = req.remote_addr() {
        headers.push((SOCKET_PEER.to_owned(), peer.ip().to_string()));
    }
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
    for (name, value) in &out.headers {
        if let Ok(h) = tiny_http::Header::from_bytes(*name, value.as_bytes()) {
            response = response.with_header(h);
        }
    }
    if method == "HEAD"
        && let Ok(h) = tiny_http::Header::from_bytes("content-length", out.body.len().to_string())
    {
        response = response.with_header(h);
    }
    // Observed once the answer is ready and before it is written, so a scrape that follows this reply sees it. Fastify's
    // `onResponse` takes its time after the write; the difference is the socket write.
    app.observe(&method, status, started.elapsed());
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
