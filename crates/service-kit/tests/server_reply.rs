//! A door's own content type and headers reach the wire (#10544): the pay-in stand-in's page is served as `text/html`
//! with its policy, and its approve redirects with `location`. Without them a browser showed the page as text and the
//! redirect went nowhere; every other answer stays JSON with no extra header.
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
use service_kit::server::{App, Door, Reply, Request, RequestIds, Response, serve};
use service_kit::telemetry::{Logger, Telemetry};

struct Pages(RequestIds);

impl Door for Pages {
    fn next_request_id(&self) -> String {
        self.0.next()
    }
    fn handle_as(&self, _req: &Request<'_>, _request_id: &str) -> Response {
        Response {
            status: 200,
            body: "{}".to_owned(),
        }
    }
    fn reply_from(&self, req: &Request<'_>, request_id: &str, peer: &str) -> Reply {
        match req.url {
            "/page" => Reply {
                response: Response {
                    status: 200,
                    body: "<p>TEST</p>".to_owned(),
                },
                content_type: Some("text/html; charset=utf-8"),
                headers: vec![("cache-control", "no-store".to_owned())],
            },
            "/go" => Reply {
                response: Response {
                    status: 303,
                    body: String::new(),
                },
                content_type: None,
                headers: vec![("location", "http://127.0.0.1:1/back?request=r1".to_owned())],
            },
            _ => self.handle_from(req, request_id, peer).into(),
        }
    }
}

fn ask(addr: std::net::SocketAddr, path: &str) -> String {
    let mut conn = TcpStream::connect(addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    conn.write_all(
        format!("GET {path} HTTP/1.1\r\nhost: svc-test\r\nconnection: close\r\n\r\n").as_bytes(),
    )
    .unwrap();
    let mut out = String::new();
    let _ = conn.read_to_string(&mut out);
    out.to_ascii_lowercase()
}

#[test]
fn a_doors_content_type_and_headers_are_sent_and_a_plain_answer_stays_json() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tiny_http::Server::from_listener(listener, None).unwrap();
    let app = App {
        wire: Pages(RequestIds::new()),
        service_name: "svc-test".to_owned(),
        ready_body: "{}".to_owned(),
    };
    let log = Logger::new("error", Box::new(std::io::sink()));
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(false, "svc-test", "", "test", fetch, log.clone());
    let stop = Arc::new(AtomicBool::new(false));
    std::thread::scope(|s| {
        s.spawn(|| serve(&server, &app, &log, &telemetry, &stop));
        let page = ask(addr, "/page");
        assert!(page.starts_with("http/1.1 200"), "{page}");
        assert!(
            page.contains("content-type: text/html; charset=utf-8"),
            "{page}"
        );
        assert!(page.contains("cache-control: no-store"), "{page}");
        assert!(!page.contains("application/json"), "{page}");
        let go = ask(addr, "/go");
        assert!(go.starts_with("http/1.1 303"), "{go}");
        assert!(
            go.contains("location: http://127.0.0.1:1/back?request=r1"),
            "{go}"
        );
        let plain = ask(addr, "/other");
        assert!(
            plain.contains("content-type: application/json; charset=utf-8"),
            "{plain}"
        );
        assert!(
            !plain.contains("location:") && !plain.contains("cache-control"),
            "{plain}"
        );
        stop.store(true, Ordering::SeqCst);
        server.unblock();
    });
}
