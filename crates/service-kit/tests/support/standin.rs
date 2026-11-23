//! A stand-in NATS server that speaks the part of the JetStream API the kit's consumer uses: `CONNECT`, `PING`,
//! `SUB`, `$JS.API.CONSUMER.CREATE` and `INFO`, pulls (`$JS.API.CONSUMER.MSG.NEXT`, one message, a `408` when the
//! wait runs out), and acks and naks on `$JS.ACK` subjects (a nak's `delay` is honoured). A message neither acked
//! nor nak'd stays in flight, never delivered again by this stand-in; an ack it is told to lose puts the message back
//! as JetStream does once `ack_wait` has passed. Shared by the kit's and the services' bus tests.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use service_kit::json::{self, Json};

#[derive(Debug, Clone)]
struct Msg {
    seq: u64,
    subject: String,
    data: Vec<u8>,
    delivered: u64,
    not_before: Instant,
}

/// What the stand-in saw and holds.
#[derive(Debug, Default)]
pub struct State {
    /// Each `$JS.API.CONSUMER.CREATE` body, as sent.
    pub creates: Vec<String>,
    /// Each delivery: (stream sequence, delivery count).
    pub deliveries: Vec<(u64, u64)>,
    /// Each ack kept: (stream sequence, delivery count).
    pub acks: Vec<(u64, u64)>,
    /// Each nak: (stream sequence, delivery count, body).
    pub naks: Vec<(u64, u64, String)>,
    /// The next acks to lose: the message comes back as if its ack never arrived.
    pub lose_acks: usize,
    queue: Vec<Msg>,
    inflight: Vec<(String, Msg)>,
    config: Option<String>,
    next_seq: u64,
}

pub struct StandIn {
    pub port: u16,
    pub state: Arc<Mutex<State>>,
}

impl StandIn {
    pub fn start() -> StandIn {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { return };
                let state = shared.clone();
                std::thread::spawn(move || serve(conn, &state));
            }
        });
        StandIn { port, state }
    }

    pub fn url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.port)
    }

    /// A message published to the stream.
    pub fn push(&self, subject: &str, data: &[u8]) {
        let mut s = self.state.lock().unwrap();
        s.next_seq += 1;
        let seq = s.next_seq;
        s.queue.push(Msg {
            seq,
            subject: subject.to_owned(),
            data: data.to_vec(),
            delivered: 0,
            not_before: Instant::now(),
        });
    }

    /// Waits until `done` holds of the state, or panics after `within`.
    pub fn until(&self, within: Duration, done: impl Fn(&State) -> bool) {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if done(&self.state.lock().unwrap()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "the stand-in never got there: {:?}",
            self.state.lock().unwrap()
        );
    }
}

fn reply(out: &mut TcpStream, subject: &str, sid: &str, body: &[u8]) {
    let mut f = format!("MSG {subject} {sid} {}\r\n", body.len()).into_bytes();
    f.extend_from_slice(body);
    f.extend_from_slice(b"\r\n");
    let _ = out.write_all(&f);
}

fn serve(conn: TcpStream, state: &Mutex<State>) {
    let mut out = conn.try_clone().unwrap();
    let mut input = BufReader::new(conn);
    let _ =
        out.write_all(b"INFO {\"server_id\":\"stand-in\",\"headers\":true,\"jetstream\":true}\r\n");
    let mut sid = String::from("1");
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let parts: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        match parts.first().map(String::as_str) {
            Some("PING") => {
                let _ = out.write_all(b"PONG\r\n");
            }
            Some("SUB") => sid = parts.last().cloned().unwrap_or_default(),
            Some("PUB" | "HPUB") => {
                let size: usize = parts.last().and_then(|n| n.parse().ok()).unwrap();
                let mut body = vec![0u8; size + 2];
                input.read_exact(&mut body).unwrap();
                body.truncate(size);
                let subject = parts.get(1).cloned().unwrap_or_default();
                let reply_to = if parts.len() >= 4 {
                    parts.get(2).cloned()
                } else {
                    None
                };
                publish(&mut out, state, &sid, &subject, reply_to.as_deref(), &body);
            }
            _ => {}
        }
    }
}

fn publish(
    out: &mut TcpStream,
    state: &Mutex<State>,
    sid: &str,
    subject: &str,
    reply_to: Option<&str>,
    body: &[u8],
) {
    let text = String::from_utf8_lossy(body).into_owned();
    let tokens: Vec<&str> = subject.split('.').collect();
    if subject.starts_with("$JS.API.CONSUMER.CREATE.") {
        let config = json::parse(&text).unwrap().get("config").unwrap().compact();
        let mut s = state.lock().unwrap();
        s.creates.push(text.clone());
        s.config = Some(config.clone());
        let answer = format!(
            r#"{{"type":"io.nats.jetstream.api.v1.consumer_create_response","stream_name":"{}","name":"{}","config":{config}}}"#,
            tokens.get(4).unwrap(),
            tokens.get(5).unwrap()
        );
        drop(s);
        reply(out, reply_to.unwrap(), sid, answer.as_bytes());
    } else if subject.starts_with("$JS.API.CONSUMER.INFO.") {
        let config = state
            .lock()
            .unwrap()
            .config
            .clone()
            .unwrap_or_else(|| "{}".to_owned());
        reply(
            out,
            reply_to.unwrap(),
            sid,
            format!(r#"{{"config":{config}}}"#).as_bytes(),
        );
    } else if subject.starts_with("$JS.API.CONSUMER.MSG.NEXT.") {
        let (stream, durable) = (tokens.get(5).unwrap(), tokens.get(6).unwrap());
        let expires = match json::parse(&text).unwrap().get("expires") {
            Some(Json::Number(n)) => format!("{n}").parse::<u64>().unwrap(),
            _ => 0,
        };
        let deadline = Instant::now() + Duration::from_nanos(expires);
        loop {
            {
                let mut s = state.lock().unwrap();
                let now = Instant::now();
                if let Some(i) = s.queue.iter().position(|m| m.not_before <= now) {
                    let mut m = s.queue.remove(i);
                    m.delivered += 1;
                    let ack = format!(
                        "$JS.ACK.{stream}.{durable}.{}.{}.{}.0.0",
                        m.delivered, m.seq, m.seq
                    );
                    s.deliveries.push((m.seq, m.delivered));
                    s.inflight.push((ack.clone(), m.clone()));
                    drop(s);
                    let mut f =
                        format!("MSG {} {sid} {ack} {}\r\n", m.subject, m.data.len()).into_bytes();
                    f.extend_from_slice(&m.data);
                    f.extend_from_slice(b"\r\n");
                    let _ = out.write_all(&f);
                    return;
                }
            }
            if Instant::now() >= deadline {
                let head = "NATS/1.0 408 Request Timeout\r\n\r\n";
                let f = format!(
                    "HMSG {} {sid} {} {}\r\n{head}\r\n",
                    reply_to.unwrap(),
                    head.len(),
                    head.len()
                );
                let _ = out.write_all(f.as_bytes());
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    } else if subject.starts_with("$JS.ACK.") {
        let mut s = state.lock().unwrap();
        let Some(i) = s.inflight.iter().position(|(a, _)| a == subject) else {
            return;
        };
        let (_, mut m) = s.inflight.remove(i);
        if text == "+ACK" || text.is_empty() {
            if s.lose_acks > 0 {
                s.lose_acks -= 1;
                m.not_before = Instant::now();
                s.queue.push(m);
            } else {
                s.acks.push((m.seq, m.delivered));
            }
        } else if let Some(rest) = text.strip_prefix("-NAK") {
            s.naks.push((m.seq, m.delivered, text.clone()));
            let delay = json::parse(rest.trim())
                .ok()
                .and_then(|v| match v.get("delay") {
                    Some(Json::Number(n)) => format!("{n}").parse::<u64>().ok(),
                    _ => None,
                })
                .unwrap_or(0);
            m.not_before = Instant::now() + Duration::from_nanos(delay);
            s.queue.push(m);
        }
    }
}
