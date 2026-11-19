//! The HTTP server (`services/svc-tax/src/index.ts`'s Fastify app): `GET /health`, `GET /ready`, and `/trpc/*` through the
//! door (`Wire`). Fastify answers HEAD for every GET route and gives every request the next request id, whatever its
//! route; both are kept. A fixed set of worker threads takes requests; on SIGTERM or SIGINT the server stops taking
//! new ones, lets those in flight finish, then the caller closes the pool and flushes tracing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant as Clock};

use crate::json::Json;
use crate::telemetry::{Logger, Started, Telemetry};
use crate::wire::{Request, Wire};

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
pub struct App {
    pub wire: Wire,
    pub service_name: String,
    pub ready_body: String,
}

const FASTIFY_JSON: &str = "application/json; charset=utf-8";

impl App {
    /// Routes one request, as Fastify would. `request_id` is already taken.
    pub fn route(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        request_id: &str,
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
        let res = self.wire.handle_as(
            &Request {
                method,
                url,
                headers,
                body,
            },
            request_id,
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
pub fn serve(
    server: &tiny_http::Server,
    app: &App,
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

fn answer(mut req: tiny_http::Request, app: &App, log: &Logger, telemetry: &Telemetry) {
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
    let out = app.route(&method, &url, &headers, &body, &request_id);
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
