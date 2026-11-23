//! One webhook POST to addresses that were already vetted (`developer-api/webhook-pinned-post.ts`; J-bank-24 #5): svc-bank's
//! copy of svc-agents' and svc-pay's.
//!
//! The kit's `fetch` resolves the name itself, so the address that passed `resolve_public_addresses` is not
//! necessarily the one it connects to (DNS rebinding). Here the agent's resolver answers only the vetted addresses, so
//! the socket opens to one of them; the original hostname is kept for TLS SNI, the certificate check and the Host
//! header. The addresses are tried in order only when the TCP connect itself fails; once connected there is no second
//! attempt. Redirects are never followed (the status comes back as is, and the caller treats a 3xx as a failure), no
//! proxy is used, no connection is pooled, and the body is never read. `timeout_ms` is one deadline for the whole call.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use ureq::config::{AutoHeaderValue, Config};
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use url::Url;

/// `PinnedPostRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedPost {
    pub url: Url,
    /// Vetted addresses, in the order to try them. Never empty.
    pub addresses: Vec<IpAddr>,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub timeout_ms: u64,
}

/// `WebhookTransport`: the status the receiver answered, or why there was none. Tests put a recorder in its place.
pub trait Transport: Send + Sync {
    fn post(&self, req: &PinnedPost) -> Result<u16, String>;
}

/// The vetted addresses, and nothing else, as the agent's DNS.
#[derive(Debug)]
struct Pinned(Vec<SocketAddr>);

impl Resolver for Pinned {
    fn resolve(
        &self,
        _uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut out = self.empty();
        for a in self.0.iter().take(16) {
            out.push(*a);
        }
        Ok(out)
    }
}

/// `pinnedPost`: the real wire.
pub struct PinnedTransport;

impl Transport for PinnedTransport {
    fn post(&self, req: &PinnedPost) -> Result<u16, String> {
        if req.addresses.is_empty() {
            return Err("webhook_no_address".to_owned());
        }
        let port = req
            .url
            .port_or_known_default()
            .ok_or_else(|| "webhook_no_port".to_owned())?;
        let config = Config::builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .max_idle_connections(0)
            .max_idle_connections_per_host(0)
            .proxy(None)
            .user_agent(AutoHeaderValue::None)
            .accept(AutoHeaderValue::None)
            .accept_encoding(AutoHeaderValue::None)
            .timeout_global(Some(Duration::from_millis(req.timeout_ms)))
            .build();
        let pinned = Pinned(
            req.addresses
                .iter()
                .map(|ip| SocketAddr::new(*ip, port))
                .collect(),
        );
        let agent = ureq::Agent::with_parts(config, DefaultConnector::new(), pinned);
        let mut out = agent.post(req.url.as_str());
        for (k, v) in &req.headers {
            out = out.header(k.as_str(), v.as_str());
        }
        // The body is never read: the answer is dropped with its connection.
        let res = out.send(req.body.as_str()).map_err(|e| e.to_string())?;
        Ok(res.status().as_u16())
    }
}

#[cfg(test)]
mod tests {
    //! `webhook-url-guard.test.ts`'s `pinnedPost` cases, each against a receiver on the loopback.
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "a test: a failure is the point"
    )]
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A receiver that answers every request with `status` (and `extra` headers), or never when `None`; it counts
    /// requests and keeps the last Host header.
    fn receiver(status: Option<u16>, extra: &'static str) -> (u16, Arc<Mutex<(u32, String)>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new((0u32, String::new())));
        let s = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !String::from_utf8_lossy(&buf).contains("\r\n\r\n{}") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                let host = text
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("host: ")
                            .or_else(|| l.strip_prefix("Host: "))
                    })
                    .unwrap_or("")
                    .to_owned();
                {
                    let mut g = s.lock().unwrap();
                    g.0 += 1;
                    g.1 = host;
                }
                match status {
                    Some(code) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {code} X\r\n{extra}content-length: 0\r\nconnection: close\r\n\r\n"
                        );
                    }
                    None => std::thread::sleep(Duration::from_secs(5)),
                }
            }
        });
        (port, seen)
    }

    fn post(url: &str, addresses: &[&str], timeout_ms: u64) -> Result<u16, String> {
        PinnedTransport.post(&PinnedPost {
            url: Url::parse(url).unwrap(),
            addresses: addresses.iter().map(|a| a.parse().unwrap()).collect(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: "{}".to_owned(),
            timeout_ms,
        })
    }

    #[test]
    fn connects_to_the_pinned_ip_and_sends_the_original_host() {
        let (port, seen) = receiver(Some(204), "");
        // `pinned.invalid` can never resolve (RFC 6761): reaching the receiver proves no lookup of the name happened.
        let url = format!("http://pinned.invalid:{port}/hook");
        assert_eq!(post(&url, &["127.0.0.1"], 5_000), Ok(204));
        assert_eq!(seen.lock().unwrap().1, format!("pinned.invalid:{port}"));
    }

    #[test]
    fn does_not_follow_a_302() {
        let (port, seen) = receiver(
            Some(302),
            "location: http://169.254.169.254/latest/meta-data/\r\n",
        );
        let url = format!("http://127.0.0.1:{port}/hook");
        assert_eq!(post(&url, &["127.0.0.1"], 5_000), Ok(302));
        assert_eq!(seen.lock().unwrap().0, 1);
    }

    #[test]
    fn times_out_instead_of_hanging() {
        let (port, _) = receiver(None, "");
        let url = format!("http://127.0.0.1:{port}/hook");
        let started = std::time::Instant::now();
        assert!(post(&url, &["127.0.0.1"], 100).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn tries_the_next_vetted_address_when_the_connect_is_refused() {
        let (port, seen) = receiver(Some(204), "");
        let url = format!("http://pinned.invalid:{port}/hook");
        assert_eq!(post(&url, &["::1", "127.0.0.1"], 5_000), Ok(204));
        assert_eq!(seen.lock().unwrap().0, 1);
    }

    #[test]
    fn rejects_when_every_vetted_address_refuses() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let url = format!("http://pinned.invalid:{port}/hook");
        assert!(post(&url, &["127.0.0.1", "::1"], 5_000).is_err());
    }

    #[test]
    fn never_moves_to_the_next_address_after_an_http_response() {
        let (port, seen) = receiver(Some(500), "");
        let url = format!("http://127.0.0.1:{port}/hook");
        assert_eq!(post(&url, &["127.0.0.1", "127.0.0.1"], 5_000), Ok(500));
        assert_eq!(seen.lock().unwrap().0, 1);
    }
}
