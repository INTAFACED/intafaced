//! A publish-only JetStream client over the NATS text protocol, synchronous, with no async runtime: what a service's
//! `JetStreamEventBus` (`packages/events/src/jetstream-bus.ts`) does when it only publishes. It connects (`CONNECT`
//! with headers on, `PING`/`PONG`), makes or reconciles its own streams (`ensureStream`: `$JS.API.STREAM.CREATE`, then
//! `$JS.API.STREAM.UPDATE` when the name is taken), and publishes each event with `HPUB` carrying `Nats-Msg-Id` (the
//! envelope's idempotency key, deduplicated by the server inside the stream's window), waiting for the stream's
//! `PubAck` on its own reply inbox.
//!
//! A connection the server dropped is dialled again on the next request, and a request that failed on it is sent once
//! more on the new one. The server drops a client that leaves its `PING`s unanswered (`Stale Connection`, about four
//! minutes idle by default), and this client reads only while a request waits, so an idle service meets that on its
//! first publish after a quiet spell. Sending a publish again is safe: the server deduplicates it by its
//! `Nats-Msg-Id`. nats.js, which the TypeScript services use, reconnects the same way.
//!
//! Not served: TLS (`tls://`), several servers with fail-over (the first URL is used), and subscribing.

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
    /// This connection's reply inbox (`_INBOX.<token>`), subscribed as `<inbox>.*`.
    inbox: String,
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
    server: Server,
    name: String,
    timeout: Duration,
}

fn random_token() -> Result<String, NatsError> {
    let mut b = [0u8; 11];
    getrandom::fill(&mut b).map_err(|e| err(format!("nats: no randomness for the inbox: {e}")))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Dials the server, says `CONNECT` as `name` and subscribes a fresh reply inbox.
fn dial(server: &Server, name: &str, timeout: Duration) -> Result<Conn, NatsError> {
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
        inbox: format!("_INBOX.{}", random_token()?),
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
    conn.send(format!("CONNECT {}\r\nPING\r\n", Json::Object(fields).compact()).as_bytes())?;
    conn.until_pong()?;
    let sub = format!("SUB {}.* 1\r\nPING\r\n", conn.inbox);
    conn.send(sub.as_bytes())?;
    conn.until_pong()?;
    Ok(conn)
}

/// Sends one request on `conn` and waits for its reply on the connection's inbox.
fn exchange(
    conn: &mut Conn,
    subject: &str,
    msg_id: Option<&str>,
    payload: &[u8],
) -> Result<(Option<u16>, Vec<u8>), NatsError> {
    conn.next += 1;
    let reply = format!("{}.{}", conn.inbox, conn.next);
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

impl JetStream {
    /// Connects as `name`, every read and write bounded by `timeout`.
    pub fn connect(urls: &str, name: &str, timeout: Duration) -> Result<JetStream, NatsError> {
        let server = parse_server(urls)?;
        let conn = dial(&server, name, timeout)?;
        Ok(JetStream {
            conn: Mutex::new(conn),
            server,
            name: name.to_owned(),
            timeout,
        })
    }

    /// Sends one request and waits for its reply: the reply's status (a header-only `503` is no responders) and body.
    /// A connection already broken is dialled again first; a request that fails on a connection that was working is
    /// sent once more on a new one, since the server may have dropped it while it sat idle.
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
        if let Some(why) = conn.broken.clone() {
            *conn = dial(&self.server, &self.name, self.timeout).map_err(|e| {
                err(format!(
                    "nats: the connection broke ({why}) and redialling failed: {e}"
                ))
            })?;
        }
        match exchange(&mut conn, subject, msg_id, payload) {
            Ok(answer) => Ok(answer),
            Err(first) => {
                let _ = conn.writer.shutdown(std::net::Shutdown::Both);
                *conn = dial(&self.server, &self.name, self.timeout)
                    .map_err(|e| err(format!("{first}; redialling failed: {e}")))?;
                exchange(&mut conn, subject, msg_id, payload)
                    .map_err(|e| err(format!("{first}; again on a new connection: {e}")))
            }
        }
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

    /// What the stand-in server does on one connection after its handshake.
    type Serve = Box<dyn FnOnce(&mut BufReader<TcpStream>, &mut TcpStream) + Send>;

    /// A stand-in server: each connection gets `INFO`, its `CONNECT`/`SUB` pings answered, then `serve` runs on it.
    fn fake_server(serves: Vec<Serve>) -> (u16, std::thread::JoinHandle<usize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let port = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("{e}"))
            .port();
        let handle = std::thread::spawn(move || {
            let mut accepted = 0;
            for serve in serves {
                let (mut out, _) = listener.accept().unwrap_or_else(|e| panic!("{e}"));
                accepted += 1;
                let mut input = BufReader::new(out.try_clone().unwrap_or_else(|e| panic!("{e}")));
                out.write_all(b"INFO {\"server_id\":\"fake\",\"headers\":true}\r\n")
                    .unwrap_or_else(|e| panic!("{e}"));
                let mut pongs = 0;
                while pongs < 2 {
                    let mut line = String::new();
                    input.read_line(&mut line).unwrap_or_else(|e| panic!("{e}"));
                    if line.starts_with("PING") {
                        out.write_all(b"PONG\r\n").unwrap_or_else(|e| panic!("{e}"));
                        pongs += 1;
                    }
                }
                serve(&mut input, &mut out);
            }
            accepted
        });
        (port, handle)
    }

    /// Reads one `HPUB <subject> <reply> <head> <total>` and its bytes; answers a `PubAck` on the reply subject.
    fn ack_one(input: &mut BufReader<TcpStream>, out: &mut TcpStream) {
        let mut line = String::new();
        input.read_line(&mut line).unwrap_or_else(|e| panic!("{e}"));
        let parts: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(parts.first().copied(), Some("HPUB"), "{line:?}");
        let reply = parts.get(2).copied().unwrap_or("").to_owned();
        let total: usize = parts.last().and_then(|n| n.parse().ok()).unwrap_or(0);
        let mut body = vec![0u8; total + 2];
        input
            .read_exact(&mut body)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(String::from_utf8_lossy(&body).contains("Nats-Msg-Id: cert:1"));
        let ack = br#"{"stream":"T_ACADEMY","seq":7}"#;
        out.write_all(format!("MSG {reply} 1 {}\r\n", ack.len()).as_bytes())
            .unwrap_or_else(|e| panic!("{e}"));
        out.write_all(ack).unwrap_or_else(|e| panic!("{e}"));
        out.write_all(b"\r\n").unwrap_or_else(|e| panic!("{e}"));
    }

    #[test]
    fn a_connection_the_server_dropped_while_idle_is_dialled_again_and_the_publish_goes_through() {
        // The first connection is dropped the way a server drops a client that left its pings unanswered.
        let (port, server) = fake_server(vec![
            Box::new(|_input, out| {
                let _ = out.write_all(b"-ERR 'Stale Connection'\r\n");
                let _ = out.shutdown(std::net::Shutdown::Both);
            }),
            Box::new(ack_one),
        ]);
        let js = JetStream::connect(
            &format!("nats://127.0.0.1:{port}"),
            "kit-test",
            Duration::from_secs(5),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        std::thread::sleep(Duration::from_millis(100));
        let ack = js
            .publish("intafaced.academy.x", "cert:1", b"{}")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((ack.stream.as_str(), ack.seq), ("T_ACADEMY", 7));
        assert_eq!(server.join().unwrap_or_else(|_| panic!("server")), 2);
    }

    #[test]
    fn a_server_that_stays_away_fails_the_publish_and_the_next_one_tries_again() {
        let (port, server) = fake_server(vec![Box::new(|_input, out| {
            let _ = out.shutdown(std::net::Shutdown::Both);
        })]);
        let js = JetStream::connect(
            &format!("nats://127.0.0.1:{port}"),
            "kit-test",
            Duration::from_secs(2),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(server.join().unwrap_or_else(|_| panic!("server")), 1);
        // The listener is gone: the redial is refused, and the publish says so.
        let first = js.publish("intafaced.academy.x", "cert:1", b"{}");
        assert!(
            first
                .as_ref()
                .is_err_and(|e| e.0.contains("redialling failed")),
            "{first:?}"
        );
        let again = js.publish("intafaced.academy.x", "cert:1", b"{}");
        assert!(
            again
                .as_ref()
                .is_err_and(|e| e.0.contains("redialling failed")),
            "{again:?}"
        );
    }
}
