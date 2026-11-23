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
//! It also consumes, as `subscribe` does: a durable pull consumer on the event's own stream, filtered to its subject
//! (`ensure_consumer`: explicit acks, every message from the start, `max_deliver` and `ack_wait` reconciled on each
//! boot), pulled one message at a time (`$JS.API.CONSUMER.MSG.NEXT`). `consume` hands each message to its work, acks
//! it only once the work has returned, and naks a failure with the TypeScript's backoff so JetStream delivers it again;
//! the work must be idempotent, since a lost ack delivers a message twice.
//!
//! Not served: TLS (`tls://`) and several servers with fail-over (the first URL is used).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// One message delivered to the inbox: its status (from `NATS/1.0 <status>`, when it came with headers), the subject
/// to answer it on (a JetStream message's ack subject) and payload.
struct Delivered {
    subject: String,
    status: Option<u16>,
    reply_to: Option<String>,
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
                    let reply_to =
                        (parts.len() == 5).then(|| parts.get(3).copied().unwrap_or("").to_owned());
                    let payload = self.bytes(size)?;
                    return Ok(Delivered {
                        subject,
                        status: None,
                        reply_to,
                        payload,
                    });
                }
                Some("HMSG") => {
                    let total = number(parts.last())?;
                    let header_len = number(parts.len().checked_sub(2).and_then(|i| parts.get(i)))?;
                    let subject = parts.get(1).copied().unwrap_or("").to_owned();
                    let reply_to =
                        (parts.len() == 6).then(|| parts.get(3).copied().unwrap_or("").to_owned());
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
                        reply_to,
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

/// `DEFAULT_MAX_DELIVER` (`jetstream-bus.ts`): a durable consumer's redelivery budget.
pub const DEFAULT_MAX_DELIVER: i64 = 5;

/// `ACK_WAIT_NS` (`jetstream-bus.ts`): 30 seconds, in nanoseconds.
pub const ACK_WAIT_NS: i64 = 30_000_000_000;

/// `nakBackoffMs`: the wait before a nak'd message comes back, doubling from one second, capped at eight.
/// `delivered` is 1 on the first delivery.
pub fn nak_backoff_ms(delivered: u64) -> u64 {
    let attempt = delivered.clamp(1, 4);
    (1_000u64 << (attempt - 1)).min(8_000)
}

/// One durable consumer, as `subscribe(name, handler, { durable })` makes it: on the stream of the event's service,
/// filtered to the event's catalog subject, refusing an envelope of another subject or version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumerSpec {
    pub stream: String,
    pub durable: String,
    pub filter_subject: String,
    /// The catalog entry's `version`.
    pub version: i64,
    pub max_deliver: i64,
    pub ack_wait_ns: i64,
}

impl ConsumerSpec {
    /// The consumer of `subject` (a catalog subject of `service`'s events) under `durable`, with the bus's defaults.
    pub fn new(service: &str, prefix: &str, subject: &str, version: i64, durable: &str) -> Self {
        ConsumerSpec {
            stream: stream_name(service, prefix),
            durable: durable.to_owned(),
            filter_subject: subject.to_owned(),
            version,
            max_deliver: DEFAULT_MAX_DELIVER,
            ack_wait_ns: ACK_WAIT_NS,
        }
    }

    /// `ensureConsumer`'s config.
    pub fn config(&self) -> Json {
        Json::obj([
            ("durable_name", Json::str(self.durable.clone())),
            ("ack_policy", Json::str("explicit")),
            ("deliver_policy", Json::str("all")),
            ("filter_subject", Json::str(self.filter_subject.clone())),
            ("max_deliver", Json::int(self.max_deliver)),
            ("ack_wait", Json::int(self.ack_wait_ns)),
        ])
    }
}

/// One message a pull delivered, before it is acked or nak'd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    /// The subject it was published on.
    pub subject: String,
    pub data: Vec<u8>,
    /// How many times it has been delivered, this time included (1 the first time).
    pub delivered: u64,
    /// The subject its ack or nak goes to (`$JS.ACK.<stream>.<consumer>.<delivered>.…`).
    pub ack_subject: String,
}

/// The delivery count of a `$JS.ACK` subject: `$JS.ACK.<stream>.<consumer>.<delivered>.<sseq>.<cseq>.<ts>.<pending>`, or
/// the form with a domain and an account hash, which puts two tokens before the stream (and may add one at the end).
fn delivered_of(ack_subject: &str) -> u64 {
    let tokens: Vec<&str> = ack_subject.split('.').collect();
    let at = if tokens.len() == 9 { 4 } else { 6 };
    tokens.get(at).and_then(|t| t.parse().ok()).unwrap_or(1)
}

/// A delivered envelope (`decodeEnvelope`), accepted as `acceptEnvelope` does: its subject and version are the
/// consumer's.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub id: String,
    pub subject: String,
    pub version: i64,
    pub producer: String,
    pub idempotency_key: String,
    pub payload: Json,
}

/// `decodeEnvelope` then `acceptEnvelope`'s subject and version checks: an envelope of another subject or version is
/// refused, never read under the wrong catalog entry. The payload's fields are the work's to check.
pub fn accept_envelope(data: &[u8], subject: &str, version: i64) -> Result<Envelope, String> {
    let text = std::str::from_utf8(data).map_err(|_| "envelope: not UTF-8".to_owned())?;
    let v = json::parse(text).map_err(|e| format!("envelope: {}", e.message))?;
    let s = |k: &str| match v.get(k) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("envelope: no {k}")),
    };
    let env = Envelope {
        id: s("id")?,
        subject: s("subject")?,
        version: match v.get("version") {
            Some(Json::Number(n)) => format!("{n}").parse().unwrap_or(-1),
            _ => return Err("envelope: no version".to_owned()),
        },
        producer: s("producer")?,
        idempotency_key: s("idempotencyKey")?,
        payload: v.get("payload").cloned().unwrap_or(Json::Null),
    };
    if env.subject != subject {
        return Err(format!(
            "Subject mismatch on delivery from producer \"{}\": subscription expects \"{subject}\", envelope carries \"{}\"",
            env.producer, env.subject
        ));
    }
    if env.version != version {
        return Err(format!(
            "Version mismatch on {subject} from producer \"{}\": envelope v{}, catalog v{version}",
            env.producer, env.version
        ));
    }
    Ok(env)
}

/// What `consume` reports, for the service's log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consumed<'a> {
    /// `announceDelivered`: a message was handed to the work (`bus.delivered`).
    Delivered { attempt: u64 },
    /// The work failed and the message was nak'd; `abandoned` when it was the last attempt `max_deliver` allows
    /// (`announceAbandoned`: JetStream will not deliver it again).
    Failed {
        attempt: u64,
        reason: &'a str,
        abandoned: bool,
    },
    /// The bus itself failed (a pull, an ack or a nak); the loop goes on after a pause.
    Bus(&'a str),
}

impl JetStream {
    /// `ensureConsumer`: creates the durable consumer, or, when it already exists, reconciles its `max_deliver` and
    /// `ack_wait` (the filter subject is the durable's own and never changes).
    pub fn ensure_consumer(&self, spec: &ConsumerSpec) -> Result<(), NatsError> {
        let create = format!("$JS.API.CONSUMER.CREATE.{}.{}", spec.stream, spec.durable);
        let body = Json::obj([
            ("stream_name", Json::str(spec.stream.clone())),
            ("config", spec.config()),
        ]);
        let live = match self.api(&create, &body) {
            Ok(answer) => answer,
            Err(e) if e.0.contains("already exists") || e.0.contains("already in use") => {
                self.consumer_info(&spec.stream, &spec.durable)?
            }
            Err(e) => return Err(e),
        };
        let Some(Json::Object(mut config)) = live.get("config").cloned() else {
            return Err(err("nats: the consumer's answer holds no config"));
        };
        let number = |k: &str| {
            config
                .iter()
                .find(|(name, _)| name == k)
                .and_then(|(_, v)| match v {
                    Json::Number(n) => format!("{n}").parse::<i64>().ok(),
                    _ => None,
                })
        };
        if number("max_deliver") == Some(spec.max_deliver)
            && number("ack_wait") == Some(spec.ack_wait_ns)
        {
            return Ok(());
        }
        for (k, v) in [
            ("max_deliver", spec.max_deliver),
            ("ack_wait", spec.ack_wait_ns),
        ] {
            match config.iter_mut().find(|(name, _)| name == k) {
                Some(slot) => slot.1 = Json::int(v),
                None => config.push((k.to_owned(), Json::int(v))),
            }
        }
        let update = Json::obj([
            ("stream_name", Json::str(spec.stream.clone())),
            ("config", Json::Object(config)),
            ("action", Json::str("update")),
        ]);
        self.api(&create, &update).map(|_| ())
    }

    /// The consumer's info (`$JS.API.CONSUMER.INFO`): its config and counts.
    pub fn consumer_info(&self, stream: &str, durable: &str) -> Result<Json, NatsError> {
        self.api(
            &format!("$JS.API.CONSUMER.INFO.{stream}.{durable}"),
            &Json::obj([]),
        )
    }

    /// Pulls one message, waiting up to `wait` (held under half the connection's timeout, so the server's end of
    /// the pull comes before the read gives up): the message, or none when the wait ran out.
    pub fn next(&self, spec: &ConsumerSpec, wait: Duration) -> Result<Option<Delivery>, NatsError> {
        let wait = wait.min(self.timeout / 2).max(Duration::from_millis(10));
        let mut conn = self.live_conn()?;
        let conn = &mut *conn;
        conn.next += 1;
        let reply = format!("{}.{}", conn.inbox, conn.next);
        let body = Json::obj([
            ("batch", Json::int(1)),
            (
                "expires",
                Json::int(i64::try_from(wait.as_nanos()).unwrap_or(i64::MAX)),
            ),
        ])
        .compact();
        let frame = format!(
            "PUB $JS.API.CONSUMER.MSG.NEXT.{}.{} {reply} {}\r\n{body}\r\n",
            spec.stream,
            spec.durable,
            body.len()
        );
        let out = conn.send(frame.as_bytes()).and_then(|()| {
            loop {
                let m = conn.next_message()?;
                if let Some(ack) = m.reply_to.as_deref().filter(|r| r.starts_with("$JS.ACK.")) {
                    break Ok(Some(Delivery {
                        delivered: delivered_of(ack),
                        ack_subject: ack.to_owned(),
                        subject: m.subject,
                        data: m.payload,
                    }));
                }
                if m.subject != reply {
                    // A late answer to an earlier request.
                    continue;
                }
                match m.status {
                    // No message waiting, or the wait ran out.
                    Some(404 | 408) => break Ok(None),
                    Some(status) => {
                        break Err(err(format!(
                            "nats: the pull ended with status {status}: {}",
                            String::from_utf8_lossy(&m.payload)
                        )));
                    }
                    None => continue,
                }
            }
        });
        if let Err(e) = &out {
            conn.broken = Some(e.0.clone());
        }
        out
    }

    /// `msg.ack()`, confirmed by a `PING` the server answers after it.
    pub fn ack(&self, d: &Delivery) -> Result<(), NatsError> {
        self.answer(d, "+ACK")
    }

    /// `msg.nak(delay)`: JetStream delivers the message again after `delay`.
    pub fn nak(&self, d: &Delivery, delay: Duration) -> Result<(), NatsError> {
        let ns = i64::try_from(delay.as_nanos()).unwrap_or(i64::MAX);
        self.answer(d, &format!("-NAK {{\"delay\":{ns}}}"))
    }

    fn answer(&self, d: &Delivery, body: &str) -> Result<(), NatsError> {
        if d.ack_subject.contains([' ', '\r', '\n']) {
            return Err(err("nats: a bad ack subject"));
        }
        let mut conn = self.live_conn()?;
        let frame = format!("PUB {} {}\r\n{body}\r\nPING\r\n", d.ack_subject, body.len());
        let out = conn.send(frame.as_bytes()).and_then(|()| conn.until_pong());
        if let Err(e) = &out {
            conn.broken = Some(e.0.clone());
        }
        out
    }

    /// The connection, dialled again first when it broke.
    fn live_conn(&self) -> Result<std::sync::MutexGuard<'_, Conn>, NatsError> {
        let mut conn = self
            .conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(why) = conn.broken.clone() {
            let _ = conn.writer.shutdown(std::net::Shutdown::Both);
            *conn = dial(&self.server, &self.name, self.timeout).map_err(|e| {
                err(format!(
                    "nats: the connection broke ({why}) and redialling failed: {e}"
                ))
            })?;
        }
        Ok(conn)
    }
}

/// `subscribe`'s pump, on its own connection, until `stop`: each message pulled is accepted (`accept_envelope`)
/// and handed to `work`; it is acked only once `work` returned `Ok`, and nak'd with `nak_backoff_ms` when the
/// envelope is refused or `work` fails, so JetStream delivers it again until `max_deliver`. A bus failure is reported
/// and the loop goes on after a second; the connection is dialled again on the next pull. `ensure_consumer` comes
/// first, at start-up.
pub fn consume(
    js: &JetStream,
    spec: &ConsumerSpec,
    wait: Duration,
    stop: &AtomicBool,
    work: &dyn Fn(&Envelope) -> Result<(), String>,
    report: &dyn Fn(Consumed<'_>),
) {
    let pause = || {
        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    while !stop.load(Ordering::Relaxed) {
        let d = match js.next(spec, wait) {
            Ok(Some(d)) => d,
            Ok(None) => continue,
            Err(e) => {
                report(Consumed::Bus(&e.0));
                pause();
                continue;
            }
        };
        report(Consumed::Delivered {
            attempt: d.delivered,
        });
        let done =
            accept_envelope(&d.data, &spec.filter_subject, spec.version).and_then(|env| work(&env));
        let answered = match done {
            Ok(()) => js.ack(&d),
            Err(reason) => {
                report(Consumed::Failed {
                    attempt: d.delivered,
                    reason: &reason,
                    abandoned: i64::try_from(d.delivered).unwrap_or(i64::MAX) >= spec.max_deliver,
                });
                js.nak(&d, Duration::from_millis(nak_backoff_ms(d.delivered)))
            }
        };
        if let Err(e) = answered {
            report(Consumed::Bus(&e.0));
        }
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
    fn a_nak_waits_as_the_typescripts_backoff_and_an_ack_subject_names_its_delivery() {
        let waits: Vec<u64> = [0, 1, 2, 3, 4, 9].map(nak_backoff_ms).to_vec();
        assert_eq!(waits, vec![1_000, 1_000, 2_000, 4_000, 8_000, 8_000]);
        assert_eq!(delivered_of("$JS.ACK.S.D.3.10.7.1700000000.0"), 3);
        assert_eq!(
            delivered_of("$JS.ACK.dom.hash.S.D.4.10.7.1700000000.0.tok"),
            4
        );
        let env = br#"{"id":"e","subject":"a.b","version":2,"producer":"p","idempotencyKey":"k","payload":{}}"#;
        assert!(accept_envelope(env, "a.b", 1).is_err_and(|e| e.contains("Version mismatch")));
        assert!(accept_envelope(env, "a.b", 2).is_ok());
        assert!(accept_envelope(b"nope", "a.b", 2).is_err());
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
