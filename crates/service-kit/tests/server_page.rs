//! A door's page answer goes out with its own content type and headers (`Door::page`).
//!
//! svc-bank's TEST pay-in page went out as JSON once it ran in Rust, so the browser never drew it and J-bank-02 #3 found no
//! label on it; its approve's 303 went out with no `location`, so the payer was never sent back to the app.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use service_kit::http::{Fetch, UreqFetch};
use service_kit::server::{Answer, App, Door, Request, RequestIds, Response, serve};
use service_kit::telemetry::{Logger, Telemetry};

struct Paged(RequestIds);

impl Door for Paged {
    fn next_request_id(&self) -> String {
        self.0.next()
    }
    fn handle_as(&self, _req: &Request<'_>, _request_id: &str) -> Response {
        Response {
            status: 200,
            body: "{}".to_owned(),
        }
    }
    fn page(&self, req: &Request<'_>, _peer: &str) -> Option<Answer> {
        match req.url {
            "/page" => Some(Answer {
                status: 200,
                content_type: "text/html; charset=utf-8",
                headers: vec![("cache-control", "no-store".to_owned())],
                body: "<p data-testid=\"label\">TEST</p>".to_owned(),
            }),
            "/page/approve" => Some(Answer {
                status: 303,
                content_type: "application/json; charset=utf-8",
                headers: vec![("location", "http://127.0.0.1:3210/back?x=1".to_owned())],
                body: String::new(),
            }),
            _ => None,
        }
    }
}

/// The raw response head (status line and headers, lower-cased) to one request.
fn ask(addr: std::net::SocketAddr, method: &str, path: &str) -> String {
    let mut conn = TcpStream::connect(addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    conn.write_all(
        format!("{method} {path} HTTP/1.1\r\nhost: svc-test\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let mut out = String::new();
    let _ = conn.read_to_string(&mut out);
    out.to_ascii_lowercase()
}

#[test]
fn a_page_answer_goes_out_with_its_content_type_and_headers_and_every_other_answer_stays_json() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tiny_http::Server::from_listener(listener, None).unwrap();
    let app = App {
        wire: Paged(RequestIds::new()),
        service_name: "svc-test".to_owned(),
        ready_body: "{}".to_owned(),
    };
    let log = Logger::new("error", Box::new(std::io::sink()));
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(false, "svc-test", "", "test", fetch, log.clone());
    let stop = Arc::new(AtomicBool::new(false));

    std::thread::scope(|s| {
        s.spawn(|| serve(&server, &app, &log, &telemetry, &stop));

        let page = ask(addr, "GET", "/page");
        assert!(page.starts_with("http/1.1 200"), "{page}");
        assert!(
            page.contains("content-type: text/html; charset=utf-8\r\n"),
            "{page}"
        );
        assert!(page.contains("cache-control: no-store\r\n"), "{page}");
        assert!(page.contains("<p data-testid=\"label\">test</p>"), "{page}");

        let back = ask(addr, "POST", "/page/approve");
        assert!(back.starts_with("http/1.1 303"), "{back}");
        assert!(
            back.contains("location: http://127.0.0.1:3210/back?x=1\r\n"),
            "{back}"
        );

        let json = ask(addr, "GET", "/other");
        assert!(json.starts_with("http/1.1 200"), "{json}");
        assert!(
            json.contains("content-type: application/json; charset=utf-8\r\n"),
            "{json}"
        );
        assert!(!json.contains("cache-control"), "{json}");

        stop.store(true, Ordering::SeqCst);
    });
}
