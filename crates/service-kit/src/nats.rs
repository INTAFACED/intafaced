//! A publish-only JetStream client over the NATS text protocol, synchronous, with no async runtime: what a service's
//! `JetStreamEventBus` (`packages/events/src/jetstream-bus.ts`) does when it only publishes. It connects (`CONNECT`
//! with headers on, `PING`/`PONG`), makes or reconciles its own streams (`ensureStream`: `$JS.API.STREAM.CREATE`, then
//! `$JS.API.STREAM.UPDATE` when the name is taken), and publishes each event with `HPUB` carrying `Nats-Msg-Id` (the
//! envelope's idempotency key, deduplicated by the server inside the stream's window), waiting for the stream's
//! `PubAck` on its own reply inbox.
//!
//! Not served: TLS (`tls://`), several servers with fail-over (the first URL is used), reconnecting (a broken
//! connection fails every later publish; the caller reports the event undelivered), and subscribing.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use crate::json::{self, Json};

/// Why the bus refused or failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NatsError(pub String);

impl std::fmt::Display for NatsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(message: impl Into<String>) -> NatsError {
    NatsError(message.into())
}

/// `streamName(service, prefix)`: `INTAFACED_LEDGER` for `ledger`.
pub fn stream_name(service: &str, prefix: &str) -> String {
    format!("{prefix}_{}", service.replace('-', "_").to_uppercase())
}

/// `wildcard(service)`: every subject of the service's events.
pub fn wildcard(service: &str) -> String {
    format!("intafaced.{service}.>")
}

/// `ensureStream`'s config: limits retention, 90 days, a two-minute dedupe window.
pub fn stream_config(service: &str, prefix: &str) -> Json {
    Json::obj([
        ("name", Json::str(stream_name(service, prefix))),
        ("subjects", Json::Array(vec![Json::str(wildcard(service))])),
        ("retention", Json::str("limits")),
        ("max_age", Json::int(90 * 24 * 60 * 60 * 1_000_000_000)),
        ("duplicate_window", Json::int(2 * 60 * 1_000_000_000)),
    ])
}

/// The stream's acknowledgement of one publish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubAck {
    pub stream: String,
    pub seq: u64,
    /// The server already held a message with this `Nats-Msg-Id`.
    pub duplicate: bool,
}

/// Where and how to connect, from a `nats://[user:pass@ | token@]host[:port]` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub pass: Option<String>,
    pub token: Option<String>,
}

/// The first server of a `NATS_URL` (comma-separated, as nats.js takes it).
pub fn parse_server(urls: &str) -> Result<Server, NatsError> {
    let first = urls
        .split(',')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .ok_or_else(|| err("NATS_URL is blank"))?;
    let with_scheme = if first.contains("://") {
        first.to_owned()
    } else {
        format!("nats://{first}")
    };
    let url =
        url::Url::parse(&with_scheme).map_err(|e| err(format!("NATS_URL does not parse: {e}")))?;
    if url.scheme() != "nats" {
        return Err(err(format!(
            "NATS_URL scheme {} is not served (only nats://)",
            url.scheme()
        )));
    }
    let host = url
        .host_str()
        .ok_or_else(|| err("NATS_URL names no host"))?
        .to_owned();
    let decode = |s: &str| crate::trpc::percent_decode(s, false);
    let user = (!url.username().is_empty()).then(|| decode(url.username()));
    let pass = url.password().map(decode);
    let (user, token) = match (&user, &pass) {
        (Some(u), None) => (None, Some(u.clone())),
        _ => (user, None),
    };
    Ok(Server {
        host,
        port: url.port().unwrap_or(4222),
        user,
        pass,
        token,
    })
}

struct Conn {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
    next: u64,
    broken: Option<String>,
}

/// One message delivered to the inbox: its status (from `NATS/1.0 <status>`, when it came with headers) and payload.
struct Delivered {
    subject: String,
    status: Option<u16>,
    payload: Vec<u8>,
}

impl Conn {
    fn line(&mut self) -> Result<String, NatsError> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| err(format!("nats: read: {e}")))?;
        if n == 0 {
            return Err(err("nats: the server closed the connection"));
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_owned())
    }

    fn bytes(&mut self, n: usize) -> Result<Vec<u8>, NatsError> {
        let mut buf = vec![0u8; n + 2];
        self.reader
            .read_exact(&mut buf)
            .map_err(|e| err(format!("nats: read: {e}")))?;
        buf.truncate(n);
        Ok(buf)
    }

    fn send(&mut self, data: &[u8]) -> Result<(), NatsError> {
        self.writer
            .write_all(data)
            .map_err(|e| err(format!("nats: write: {e}")))?;
        self.writer
            .flush()
            .map_err(|e| err(format!("nats: write: {e}")))
    }

    /// Reads until `PONG`, answering the server's `PING`s; `-ERR` refuses.
    fn until_pong(&mut self) -> Result<(), NatsError> {
        loop {
            let line = self.line()?;
            match line.split(' ').next().unwrap_or("") {
                "PONG" => return Ok(()),
                "PING" => self.send(b"PONG\r\n")?,
                "-ERR" => return Err(err(format!("nats: {}", line.trim_start_matches("-ERR ")))),
                _ => {}
            }
        }
    }

    /// The next message, answering `PING`s; `-ERR` refuses.
    fn next_message(&mut self) -> Result<Delivered, NatsError> {
        loop {
            let line = self.line()?;
            let parts: Vec<&str> = line.split(' ').filter(|p| !p.is_empty()).collect();
            let number = |s: Option<&&str>| -> Result<usize, NatsError> {
                s.and_then(|v| v.parse().ok())
                    .ok_or_else(|| err(format!("nats: bad line {line:?}")))
            };
            match parts.first().copied() {
                Some("PING") => self.send(b"PONG\r\n")?,
                Some("-ERR") => {
                    return Err(err(format!("nats: {}", line.trim_start_matches("-ERR "))));
                }
                Some("MSG") => {
                    let size = number(parts.last())?;
                    let subject = parts.get(1).copied().unwrap_or("").to_owned();
                    let payload = self.bytes(size)?;
                    return Ok(Delivered {
                        subject,
                        status: None,
                        payload,
                    });
                }
                Some("HMSG") => {
                    let total = number(parts.last())?;
                    let header_len = number(parts.len().checked_sub(2).and_then(|i| parts.get(i)))?;
                    let subject = parts.get(1).copied().unwrap_or("").to_owned();
                    let mut all = self.bytes(total)?;
                    let payload = all.split_off(header_len.min(all.len()));
                    let head = String::from_utf8_lossy(&all);
                    let status = head
                        .lines()
                        .next()
                        .and_then(|first| first.strip_prefix("NATS/1.0"))
                        .and_then(|rest| rest.split_whitespace().next())
                        .and_then(|code| code.parse().ok());
                    return Ok(Delivered {
                        subject,
                        status,
                        payload,
                    });
                }
                _ => {}
            }
        }
    }
}

/// A connection to one NATS server, publishing to JetStream. Shared between threads; one request at a time.
pub struct JetStream {
    conn: Mutex<Conn>,
    inbox: String,
}

fn random_token() -> Result<String, NatsError> {
    let mut b = [0u8; 11];
    getrandom::fill(&mut b).map_err(|e| err(format!("nats: no randomness for the inbox: {e}")))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

impl JetStream {
    /// Connects as `name`, every read and write bounded by `timeout`.
    pub fn connect(urls: &str, name: &str, timeout: Duration) -> Result<JetStream, NatsError> {
        let server = parse_server(urls)?;
        let addr = std::net::ToSocketAddrs::to_socket_addrs(&(server.host.as_str(), server.port))
            .map_err(|e| err(format!("nats: {}:{}: {e}", server.host, server.port)))?
            .next()
            .ok_or_else(|| err(format!("nats: {} does not resolve", server.host)))?;
        let stream = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| err(format!("nats: connect: {e}")))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| err(e.to_string()))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| err(e.to_string()))?;
        let reader = BufReader::new(stream.try_clone().map_err(|e| err(e.to_string()))?);
        let mut conn = Conn {
            writer: stream,
            reader,
            next: 0,
            broken: None,
        };
        let info = conn.line()?;
        if !info.starts_with("INFO ") {
            return Err(err(format!("nats: expected INFO, got {info:?}")));
        }
        let mut fields = vec![
            ("verbose".to_owned(), Json::Bool(false)),
            ("pedantic".to_owned(), Json::Bool(false)),
            ("lang".to_owned(), Json::str("rust")),
            ("version".to_owned(), Json::str("0.0.0")),
            ("protocol".to_owned(), Json::int(1)),
            ("headers".to_owned(), Json::Bool(true)),
            ("no_responders".to_owned(), Json::Bool(true)),
            ("name".to_owned(), Json::str(name)),
        ];
        if let Some(u) = &server.user {
            fields.push(("user".to_owned(), Json::str(u.clone())));
        }
        if let Some(p) = &server.pass {
            fields.push(("pass".to_owned(), Json::str(p.clone())));
        }
        if let Some(t) = &server.token {
            fields.push(("auth_token".to_owned(), Json::str(t.clone())));
        }
        let inbox = format!("_INBOX.{}", random_token()?);
        conn.send(format!("CONNECT {}\r\nPING\r\n", Json::Object(fields).compact()).as_bytes())?;
        conn.until_pong()?;
        conn.send(format!("SUB {inbox}.* 1\r\nPING\r\n").as_bytes())?;
        conn.until_pong()?;
        Ok(JetStream {
            conn: Mutex::new(conn),
            inbox,
        })
    }

    /// Sends one request and waits for its reply: the reply's status (a header-only `503` is no responders) and body.
    fn request(
        &self,
        subject: &str,
        msg_id: Option<&str>,
        payload: &[u8],
    ) -> Result<(Option<u16>, Vec<u8>), NatsError> {
        let mut conn = self
            .conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(why) = &conn.broken {
            return Err(err(format!("nats: the connection is broken: {why}")));
        }
        conn.next += 1;
        let reply = format!("{}.{}", self.inbox, conn.next);
        let mut frame = match msg_id {
            Some(id) => {
                let head = format!("NATS/1.0\r\nNats-Msg-Id: {id}\r\n\r\n");
                let total = head.len() + payload.len();
                let mut f =
                    format!("HPUB {subject} {reply} {} {total}\r\n{head}", head.len()).into_bytes();
                f.extend_from_slice(payload);
                f
            }
            None => {
                let mut f = format!("PUB {subject} {reply} {}\r\n", payload.len()).into_bytes();
                f.extend_from_slice(payload);
                f
            }
        };
        frame.extend_from_slice(b"\r\n");
        let out = conn.send(&frame).and_then(|()| {
            loop {
                let m = conn.next_message()?;
                // A late reply to an earlier request that timed out is not this one's.
                if m.subject == reply {
                    break Ok((m.status, m.payload));
                }
            }
        });
        if let Err(e) = &out {
            conn.broken = Some(e.0.clone());
        }
        out
    }

    /// A JetStream API call: its JSON answer, or the API's error as a refusal.
    fn api(&self, subject: &str, body: &Json) -> Result<Json, NatsError> {
        let (status, payload) = self.request(subject, None, body.compact().as_bytes())?;
        if status == Some(503) {
            return Err(err(
                "nats: no responders: JetStream is not enabled on the server",
            ));
        }
        let text = String::from_utf8_lossy(&payload);
        let answer =
            json::parse(&text).map_err(|e| err(format!("nats: {subject}: {}", e.message)))?;
        if let Some(e) = answer.get("error") {
            let description = match e.get("description") {
                Some(Json::String(d)) => d.clone(),
                _ => e.compact(),
            };
            return Err(err(description));
        }
        Ok(answer)
    }

    /// `ensureStream`: creates the stream, or reconciles it when its name is already in use.
    pub fn ensure_stream(&self, config: &Json) -> Result<(), NatsError> {
        let Some(Json::String(name)) = config.get("name") else {
            return Err(err("nats: a stream config names no stream"));
        };
        match self.api(&format!("$JS.API.STREAM.CREATE.{name}"), config) {
            Ok(_) => Ok(()),
            Err(e) if e.0.contains("already in use") || e.0.contains("stream name already") => self
                .api(&format!("$JS.API.STREAM.UPDATE.{name}"), config)
                .map(|_| ()),
            Err(e) => Err(e),
        }
    }

    /// `js.publish(subject, payload, { msgID })`: the stream's acknowledgement, or why it failed.
    pub fn publish(
        &self,
        subject: &str,
        msg_id: &str,
        payload: &[u8],
    ) -> Result<PubAck, NatsError> {
        if msg_id.contains(['\r', '\n']) {
            return Err(err("nats: a Nats-Msg-Id may not hold a line break"));
        }
        let (status, body) = self.request(subject, Some(msg_id), payload)?;
        if status == Some(503) {
            return Err(err(format!("nats: no stream holds {subject}")));
        }
        let ack = json::parse(&String::from_utf8_lossy(&body))
            .map_err(|e| err(format!("nats: PubAck: {}", e.message)))?;
        if let Some(e) = ack.get("error") {
            return Err(err(match e.get("description") {
                Some(Json::String(d)) => d.clone(),
                _ => e.compact(),
            }));
        }
        let stream = match ack.get("stream") {
            Some(Json::String(s)) => s.clone(),
            _ => return Err(err("nats: PubAck names no stream")),
        };
        let seq = match ack.get("seq") {
            Some(Json::Number(n)) => format!("{n}").parse().unwrap_or(0),
            _ => 0,
        };
        Ok(PubAck {
            stream,
            seq,
            duplicate: matches!(ack.get("duplicate"), Some(Json::Bool(true))),
        })
    }

    /// Closes the connection.
    pub fn close(&self) {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = conn.writer.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nats_url_names_its_first_server_and_credentials() {
        let s = parse_server("nats://user:p%40ss@nats:4223, nats://other")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((s.host.as_str(), s.port), ("nats", 4223));
        assert_eq!(
            (s.user.as_deref(), s.pass.as_deref()),
            (Some("user"), Some("p@ss"))
        );
        let t = parse_server("nats://tok@localhost").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((t.token.as_deref(), t.port), (Some("tok"), 4222));
        assert!(parse_server("tls://x").is_err());
        assert!(parse_server(" ").is_err());
    }

    #[test]
    fn the_stream_is_the_typescripts() {
        assert_eq!(
            stream_config("academy", "INTAFACED").compact(),
            r#"{"name":"INTAFACED_ACADEMY","subjects":["intafaced.academy.>"],"retention":"limits","max_age":7776000000000000,"duplicate_window":120000000000}"#
        );
        assert_eq!(stream_name("mining-pool", "X"), "X_MINING_POOL");
    }
}
