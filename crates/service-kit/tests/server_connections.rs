//! The HTTP server answers every connection opened at once, while the others stay open (#9432).
//!
//! tiny_http gives each open connection a pool thread for as long as it stays open. Its pool used to read "an idle thread
//! is waiting" from a count that a woken thread lowers only once it holds the lock again, so connections that arrived
//! together were queued behind threads that were already taken, and each waited until some other connection closed. The
//! edge keeps an idle connection for 4 s, so the console's parallel reads reached svc-academy one every 4 s and its 8 s
//! bound gave up on the third ("svc-academy did not answer", J-academy-12 #6 and #1). Here no connection ever closes
//! until every one has its answer, so a connection left in the queue is never answered and the test fails on it.
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
use std::time::{Duration, Instant};

use service_kit::http::{Fetch, UreqFetch};
use service_kit::server::{App, Door, Request, RequestIds, Response, serve};
use service_kit::telemetry::{Logger, Telemetry};

struct Plain(RequestIds);

impl Door for Plain {
    fn next_request_id(&self) -> String {
        self.0.next()
    }
    fn handle_as(&self, _req: &Request<'_>, _request_id: &str) -> Response {
        Response {
            status: 200,
            body: "{}".to_owned(),
        }
    }
}

/// More connections at once than the pool keeps idle threads (4) or the server has workers (16).
const AT_ONCE: usize = 100;
/// Far below the 4 s a stalled connection waited for another to close.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);

#[test]
fn every_connection_opened_at_once_is_answered_while_the_others_stay_open() {
    for round in 0..5 {
        // Every connection is made, and has asked, before the server takes the first: they wait in the listen queue
        // and the server's accept thread hands them to its pool back to back, as when a page's parallel reads arrive.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut conns: Vec<TcpStream> = (0..AT_ONCE)
            .map(|_| TcpStream::connect(addr).unwrap())
            .collect();
        for conn in &mut conns {
            conn.write_all(b"GET /trpc/admin.courseRelease HTTP/1.1\r\nhost: svc-test\r\n\r\n")
                .unwrap();
        }
        let server = tiny_http::Server::from_listener(listener, None).unwrap();
        let app = App {
            wire: Plain(RequestIds::new()),
            service_name: "svc-test".to_owned(),
            ready_body: "{}".to_owned(),
        };
        let log = Logger::new("error", Box::new(std::io::sink()));
        let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
        let telemetry = Telemetry::start(false, "svc-test", "", "test", fetch, log.clone());
        let stop = Arc::new(AtomicBool::new(false));

        std::thread::scope(|s| {
            s.spawn(|| serve(&server, &app, &log, &telemetry, &stop));

            // No connection closes until every one has its answer.
            let deadline = Instant::now() + ANSWER_WITHIN;
            let mut unanswered = Vec::new();
            for (i, conn) in conns.iter_mut().enumerate() {
                let left = deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1));
                conn.set_read_timeout(Some(left)).unwrap();
                let mut head = [0u8; 12];
                if conn.read_exact(&mut head).is_err() || &head != b"HTTP/1.1 200" {
                    unanswered.push(i);
                }
            }
            stop.store(true, Ordering::SeqCst);
            drop(conns);
            assert!(
                unanswered.is_empty(),
                "round {round}: {} of {AT_ONCE} connections opened at once got no answer within {ANSWER_WITHIN:?} of the first while the others stayed open: {unanswered:?}",
                unanswered.len()
            );
        });
    }
}
