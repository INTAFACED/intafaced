//! The lobbies against a real Postgres (`TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL`, an admin database whose
//! name ends in `_test`; without one it skips, with `REQUIRE_POSTGRES=1` it fails). Ported from
//! `start-session-room.test.ts`, `lobbies/room-pinned-lessons.db.test.ts` and the lobbies case of
//! `learning/customer.db.test.ts`, with the seat invariants and each crash point's failure branch beside them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use postgres::{Client, NoTls};
use service_kit::edge;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::server::Request;
use service_kit::time::{Instant, zod_datetime};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig};
use svc_academy::errors::{AcademyError, Refusal};
use svc_academy::lobbies::seat::Access;
use svc_academy::lobbies::spine;
use svc_academy::lobbies::store::{Lobbies, NewRoom};
use svc_academy::lobbies::stream::{LiveKit, LiveKitOptions};
use svc_academy::ports::{self, HostRights, NullStream, Ports, Stake, Stream, StreamCredential};
use svc_academy::settings::Settings;

const SESSION_ID: &str = "11111111-1111-4111-8111-111111111111";
const HOST_ID: &str = "22222222-2222-4222-8222-222222222222";
const GUEST: &str = "44444444-4444-4444-8444-444444444444";

// ── The database ─────────────────────────────────────────────────────────────────────────────────────────────────

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_ACADEMY").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_ACADEMY or TEST_DATABASE_URL is required"
    );
    url
}

struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// A fresh database with every academy migration applied by the binary itself.
    fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        let current: String = a
            .query_one("SELECT current_database()", &[])
            .unwrap()
            .get(0);
        assert!(
            current.ends_with("_test"),
            "refusing: {current} is not a test database"
        );
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_lobbies_{}_{}_{nanos:x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        db.client()
            .batch_execute("CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"academy\"")
            .unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_svc-academy"))
            .arg("migrate")
            .env("DATABASE_URL", &db.url)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        Some(db)
    }

    fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    fn store(&self) -> Store {
        Store::Pool(Pool::new(&self.url, 8))
    }

    fn exec(&self, sql: &str) {
        self.client().batch_execute(sql).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    /// A free room of ten seats hosted by `HOST_ID`.
    fn room(&self, slug: &str) -> String {
        self.client()
            .query_one(
                "INSERT INTO academy.rooms (slug, name, kind, access, min_stake, capacity, host_id)
                 VALUES ($1, 'Session race', 'general', 'free', 0, 10, $2::text::uuid) RETURNING id::text",
                &[&slug, &HOST_ID],
            )
            .unwrap()
            .get(0)
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

macro_rules! db_or_skip {
    () => {
        match TestDb::new() {
            Some(db) => db,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── The fakes ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `deferred()`: a gate that opens once and stays open.
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn wait(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }
}

type OpenFn = Box<dyn Fn(&str) -> Result<String, Refusal> + Send + Sync>;
type CloseFn = Box<dyn Fn(&str) -> Result<(), Refusal> + Send + Sync>;

/// A `StreamProvider` written in the test, named `livekit`.
struct FakeStream {
    open: OpenFn,
    close: CloseFn,
}

impl Stream for FakeStream {
    fn id(&self) -> &str {
        "livekit"
    }
    fn usable(&self) -> bool {
        true
    }
    fn constructed(&self) -> bool {
        true
    }
    fn probed(&self) -> bool {
        false
    }
    fn open_room(&self, session_id: &str) -> Result<String, Refusal> {
        (self.open)(session_id)
    }
    fn credential(&self, _: &str, _: &str, _: &str, _: &str) -> Result<StreamCredential, Refusal> {
        Ok(StreamCredential {
            url: "wss://stream.example".to_owned(),
            token: "t".to_owned(),
            expires_at: Instant(0),
        })
    }
    fn close_room(&self, stream_room: &str) -> Result<(), Refusal> {
        (self.close)(stream_room)
    }
}

struct MayHost;
impl HostRights for MayHost {
    fn perks_of(&self, _: &str) -> Result<Json, Refusal> {
        let mut p = ports::base_perks();
        if let Json::Object(f) = &mut p {
            for (k, v) in f.iter_mut() {
                if k == "lobbyHostRights" {
                    *v = Json::Bool(true);
                }
            }
        }
        Ok(p)
    }
}

/// A stake source that answers `value`, after `started` is opened and `finish` lets it, or refuses.
struct HeldStake {
    started: Arc<Gate>,
    finish: Arc<Gate>,
    value: Result<i128, Refusal>,
}
impl Stake for HeldStake {
    fn stake_of(&self, _: &str) -> Result<i128, Refusal> {
        self.started.open();
        self.finish.wait();
        self.value.clone()
    }
}

struct Fixed(i128);
impl Stake for Fixed {
    fn stake_of(&self, _: &str) -> Result<i128, Refusal> {
        Ok(self.0)
    }
}

fn ports_with(stream: Box<dyn Stream>) -> Ports {
    let mut ports = Ports::unwired();
    ports.host_rights = Box::new(MayHost);
    ports.stake = Box::new(Fixed(0));
    ports.stream = stream;
    ports
}

fn at(iso: &str) -> Instant {
    zod_datetime(iso, false).unwrap()
}

fn lobbies<'a>(store: &'a Store, ports: &'a Ports, max: Option<&'a Json>) -> Lobbies<'a> {
    Lobbies {
        store,
        ports,
        max_room_capacity: max,
        now: at("2026-10-11T00:30:00.000Z"),
    }
}

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(AcademyError { code, .. }) => code.clone(),
        other => format!("{other:?}"),
    }
}

fn message(r: &Refusal) -> String {
    match r {
        Refusal::Academy(AcademyError { message, .. }) | Refusal::Internal { message, .. } => {
            message.clone()
        }
        other => format!("{other:?}"),
    }
}

fn schedule(l: &Lobbies<'_>, room: &str) -> String {
    l.schedule_session(
        room,
        HOST_ID,
        "Session race",
        at("2026-10-11T00:00:00.000Z"),
    )
    .unwrap()
    .id
}

// ── start-session-room.test.ts: the conditional update matches no row ────────────────────────────────────────────

/// A provider whose `openRoom` is raced by another start: before it returns, the session is taken live with
/// `winner-room` on another connection, so this call's conditional update matches nothing.
fn raced_stream(db: &TestDb, returns: &'static str, closed: Arc<Mutex<Vec<String>>>) -> FakeStream {
    let side = Mutex::new(db.client());
    FakeStream {
        open: Box::new(move |session| {
            side.lock()
                .unwrap()
                .execute(
                    "UPDATE academy.sessions SET status = 'live', stream_provider = 'livekit', stream_room = 'winner-room'
                      WHERE id = $1::text::uuid",
                    &[&session],
                )
                .unwrap();
            Ok(returns.to_owned())
        }),
        close: Box::new(move |room| {
            closed.lock().unwrap().push(room.to_owned());
            Ok(())
        }),
    }
}

#[test]
fn a_start_that_loses_the_update_refuses_and_does_not_leave_its_attempt_room_open() {
    let db = db_or_skip!();
    let store = db.store();
    let closed = Arc::new(Mutex::new(Vec::new()));
    let ports = ports_with(Box::new(raced_stream(&db, "attempt-room", closed.clone())));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("miss-attempt"));
    let refused = l.start_session(&session, HOST_ID).unwrap_err();
    assert!(matches!(refused, Refusal::Academy(_)), "{refused:?}");
    assert_eq!(code(&refused), "academy.session_not_live");
    assert_eq!(*closed.lock().unwrap(), ["attempt-room"]);
    assert_eq!(
        l.session(&session).unwrap().stream_room.as_deref(),
        Some("winner-room")
    );
}

#[test]
fn a_start_that_loses_the_update_does_not_close_the_room_already_stored_on_the_session() {
    let db = db_or_skip!();
    let store = db.store();
    let closed = Arc::new(Mutex::new(Vec::new()));
    let ports = ports_with(Box::new(raced_stream(&db, "winner-room", closed.clone())));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("miss-winner"));
    assert!(matches!(
        l.start_session(&session, HOST_ID).unwrap_err(),
        Refusal::Academy(_)
    ));
    assert!(closed.lock().unwrap().is_empty());
}

#[test]
fn a_start_that_wins_the_update_stores_the_room_it_opened() {
    let db = db_or_skip!();
    let store = db.store();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (o, c) = (opened.clone(), closed.clone());
    let ports = ports_with(Box::new(FakeStream {
        open: Box::new(move |_| {
            o.lock().unwrap().push("attempt-room".to_owned());
            Ok("attempt-room".to_owned())
        }),
        close: Box::new(move |room| {
            c.lock().unwrap().push(room.to_owned());
            Ok(())
        }),
    }));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("update-stores"));
    let started = l.start_session(&session, HOST_ID).unwrap();
    assert_eq!(started.status, "live");
    assert_eq!(started.stream_room.as_deref(), Some("attempt-room"));
    assert_eq!(started.stream_provider.as_deref(), Some("livekit"));
    assert_eq!(*opened.lock().unwrap(), ["attempt-room"]);
    assert!(closed.lock().unwrap().is_empty());
}

#[test]
fn a_start_whose_room_cannot_open_leaves_the_session_scheduled() {
    let db = db_or_skip!();
    let store = db.store();
    let ports = ports_with(Box::new(FakeStream {
        open: Box::new(|_| {
            Err(Refusal::Academy(AcademyError::new(
                "LiveKit CreateRoom failed with HTTP 503",
                "academy.stream_unavailable",
            )))
        }),
        close: Box::new(|_| panic!("nothing was opened")),
    }));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("open-fails"));
    assert_eq!(
        code(&l.start_session(&session, HOST_ID).unwrap_err()),
        "academy.stream_unavailable"
    );
    let s = l.session(&session).unwrap();
    assert_eq!((s.status.as_str(), s.stream_room), ("scheduled", None));
}

// ── start-session-room.test.ts: room lifetime with PostgreSQL ────────────────────────────────────────────────────

#[test]
fn a_delayed_room_recreation_is_closed_while_the_end_deletion_acknowledgement_is_paused() {
    let db = db_or_skip!();
    let store = db.store();
    let both_open_calls_started = Arc::new(Gate::default());
    let room_created = Arc::new(Gate::default());
    let first_room_deleted = Arc::new(Gate::default());
    let acknowledge_first_close = Arc::new(Gate::default());
    let allow_room_open = Arc::new(Gate::default());
    let active = Arc::new(Mutex::new(BTreeSet::new()));
    let closed = Arc::new(Mutex::new(Vec::<String>::new()));
    let open_calls = Arc::new(AtomicUsize::new(0));
    let stream = {
        let (both, created, allow, active_o, calls) = (
            both_open_calls_started.clone(),
            room_created.clone(),
            allow_room_open.clone(),
            active.clone(),
            open_calls.clone(),
        );
        let (deleted, ack, active_c, closed_c) = (
            first_room_deleted.clone(),
            acknowledge_first_close.clone(),
            active.clone(),
            closed.clone(),
        );
        FakeStream {
            open: Box::new(move |_| {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if n == 2 {
                    both.open();
                }
                if n == 1 {
                    both.wait();
                    active_o
                        .lock()
                        .unwrap()
                        .insert("same-session-room".to_owned());
                    return Ok("same-session-room".to_owned());
                }
                created.open();
                allow.wait();
                active_o
                    .lock()
                    .unwrap()
                    .insert("same-session-room".to_owned());
                Ok("same-session-room".to_owned())
            }),
            close: Box::new(move |room| {
                let first = {
                    let mut c = closed_c.lock().unwrap();
                    c.push(room.to_owned());
                    c.len() == 1
                };
                active_c.lock().unwrap().remove(room);
                if first {
                    deleted.open();
                    ack.wait();
                }
                Ok(())
            }),
        }
    };
    let ports = ports_with(Box::new(stream));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("delayed-start-end-race"));
    let (results, ended) = thread::scope(|s| {
        let (tx, rx) = std::sync::mpsc::channel();
        for _ in 0..2 {
            let tx = tx.clone();
            let (l, session) = (&l, &session);
            s.spawn(move || tx.send(l.start_session(session, HOST_ID)).unwrap());
        }
        both_open_calls_started.wait();
        room_created.wait();
        // `Promise.any(starting)`: the start not held returns first, and it won the update.
        let first = rx.recv().unwrap();
        assert!(first.is_ok(), "{first:?}");
        let ending = s.spawn(|| l.end_session(&session, HOST_ID, at("2026-10-11T01:00:00.000Z")));
        first_room_deleted.wait();
        allow_room_open.open();
        let second = rx.recv().unwrap();
        acknowledge_first_close.open();
        (vec![first.is_ok(), second.is_ok()], ending.join().unwrap())
    });
    assert_eq!(ended.unwrap().status, "ended");
    let mut statuses = results;
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [false, true],
        "one start fulfilled and one rejected"
    );
    assert_eq!(l.session(&session).unwrap().status, "ended");
    assert_eq!(
        *closed.lock().unwrap(),
        ["same-session-room", "same-session-room"]
    );
    assert!(active.lock().unwrap().is_empty());
}

#[test]
fn a_paused_join_is_refused_after_its_locked_session_becomes_terminal() {
    for terminal in ["ended", "cancelled", "missing"] {
        let db = db_or_skip!();
        let store = db.store();
        let stake_started = Arc::new(Gate::default());
        let finish_stake = Arc::new(Gate::default());
        let mut ports = ports_with(Box::new(NullStream));
        ports.stake = Box::new(HeldStake {
            started: stake_started.clone(),
            finish: finish_stake.clone(),
            value: Ok(parse_amount("1").unwrap()),
        });
        let l = lobbies(&store, &ports, None);
        let room = db.room(&format!("paused-join-{terminal}"));
        let session = schedule(&l, &room);
        db.exec(&format!(
            "UPDATE academy.rooms SET access = 'staked', min_stake = 1 WHERE id = '{room}'"
        ));
        l.start_session(&session, HOST_ID).unwrap();
        db.exec(&format!("INSERT INTO academy.session_attendees (session_id, user_id) VALUES ('{session}', '{GUEST}')"));
        let joined = thread::scope(|s| {
            let joining = s.spawn(|| l.join(&session, GUEST));
            stake_started.wait();
            match terminal {
                "ended" => {
                    l.end_session(&session, HOST_ID, at("2026-10-11T01:00:00.000Z")).unwrap();
                }
                "cancelled" => db.exec(&format!(
                    "UPDATE academy.sessions SET status = 'cancelled' WHERE id = '{session}';
                     UPDATE academy.session_attendees SET left_at = now() WHERE session_id = '{session}'"
                )),
                _ => db.exec(&format!("DELETE FROM academy.sessions WHERE id = '{session}'")),
            }
            finish_stake.open();
            joining.join().unwrap()
        });
        assert_eq!(
            code(&joined.unwrap_err()),
            "academy.session_not_live",
            "{terminal}"
        );
        assert_eq!(l.occupancy(&session).unwrap(), 0, "{terminal}");
        if terminal != "missing" {
            assert_eq!(l.session(&session).unwrap().status, terminal);
        }
    }
}

/// LiveKit over a fake wire: `CreateRoom` records the room; the first `DeleteRoom` throws (after deleting, when
/// `deleted`); the retry answers 200, or 404 when `retry_acknowledged` is false.
struct FlakyLiveKit {
    active: Mutex<BTreeSet<String>>,
    close_calls: AtomicUsize,
    deleted: bool,
    retry_acknowledged: bool,
}

impl Fetch for FlakyLiveKit {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let payload = json::parse(req.body.as_deref().unwrap()).unwrap();
        if let Some(Json::String(name)) = payload.get("name") {
            self.active.lock().unwrap().insert(name.clone());
            return Ok(HttpResponse {
                status: 200,
                body: Json::obj([("name", Json::str(name))]).compact(),
            });
        }
        let Some(Json::String(room)) = payload.get("room") else {
            panic!("{payload:?}")
        };
        let n = self.close_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n == 1 {
            if self.deleted {
                self.active.lock().unwrap().remove(room);
            }
            let message = if self.deleted {
                "delete acknowledgement lost"
            } else {
                "delete transport failed"
            };
            return Err(FetchError {
                message: message.to_owned(),
            });
        }
        if !self.retry_acknowledged {
            return Ok(HttpResponse {
                status: 404,
                body: r#"{"code":"not_found"}"#.to_owned(),
            });
        }
        self.active.lock().unwrap().remove(room);
        Ok(HttpResponse {
            status: 200,
            body: "{}".to_owned(),
        })
    }
}

#[test]
fn end_keeps_a_recoverable_terminal_state_after_the_provider_close_fails() {
    for (deleted, retry_acknowledged) in [(false, true), (true, true), (true, false)] {
        let db = db_or_skip!();
        let store = db.store();
        let wire = Arc::new(FlakyLiveKit {
            active: Mutex::default(),
            close_calls: AtomicUsize::new(0),
            deleted,
            retry_acknowledged,
        });
        let stream = LiveKit::new(
            LiveKitOptions {
                url: "wss://stream.example".to_owned(),
                api_key: "test-key".to_owned(),
                api_secret: "test-secret".to_owned(),
                token_ttl_seconds: 3600,
            },
            wire.clone(),
        );
        let ports = ports_with(Box::new(stream));
        let l = lobbies(&store, &ports, None);
        let session = schedule(
            &l,
            &db.room(&format!("retry-close-{deleted}-{retry_acknowledged}")),
        );
        let started = l.start_session(&session, HOST_ID).unwrap();
        db.exec(&format!("INSERT INTO academy.session_attendees (session_id, user_id) VALUES ('{session}', '{HOST_ID}')"));
        let ended_at = at("2026-10-11T01:00:00.000Z");
        let failed = l.end_session(&session, HOST_ID, ended_at).unwrap_err();
        assert!(message(&failed).contains("delete"), "{failed:?}");
        let terminal = l.session(&session).unwrap();
        assert_eq!(terminal.status, "ended");
        assert_eq!(terminal.ends_at, Some(ended_at));
        assert_eq!(terminal.stream_room, started.stream_room);
        assert_eq!(l.occupancy(&session).unwrap(), 0);
        assert_eq!(
            code(&l.start_session(&session, HOST_ID).unwrap_err()),
            "academy.session_not_live"
        );
        let retry = l.end_session(&session, HOST_ID, at("2026-10-11T02:00:00.000Z"));
        if retry_acknowledged {
            retry.unwrap();
        } else {
            assert_eq!(code(&retry.unwrap_err()), "academy.stream_unavailable");
        }
        let retried = l.session(&session).unwrap();
        assert_eq!(retried.status, "ended");
        assert_eq!(retried.ends_at, Some(ended_at));
        assert!(
            wire.active.lock().unwrap().is_empty(),
            "{deleted} {retry_acknowledged}"
        );
        assert_eq!(wire.close_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            code(&l.end_session(&session, SESSION_ID, ended_at).unwrap_err()),
            "academy.not_host"
        );
        assert_eq!(wire.close_calls.load(Ordering::SeqCst), 2);
    }
}

#[test]
fn the_shared_provider_room_stays_open_for_the_start_that_won_the_live_update() {
    let db = db_or_skip!();
    let store = db.store();
    let two_opens_started = Arc::new(Gate::default());
    let allow_room_open = Arc::new(Gate::default());
    let active = Arc::new(Mutex::new(BTreeSet::new()));
    let closed = Arc::new(Mutex::new(Vec::<String>::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let stream = {
        let (two, allow, active_o, calls) = (
            two_opens_started.clone(),
            allow_room_open.clone(),
            active.clone(),
            calls.clone(),
        );
        let (active_c, closed_c) = (active.clone(), closed.clone());
        FakeStream {
            open: Box::new(move |_| {
                if calls.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                    two.open();
                }
                allow.wait();
                active_o
                    .lock()
                    .unwrap()
                    .insert("shared-session-room".to_owned());
                Ok("shared-session-room".to_owned())
            }),
            close: Box::new(move |room| {
                closed_c.lock().unwrap().push(room.to_owned());
                active_c.lock().unwrap().remove(room);
                Ok(())
            }),
        }
    };
    let ports = ports_with(Box::new(stream));
    let l = lobbies(&store, &ports, None);
    let session = schedule(&l, &db.room("shared-room-start-race"));
    let mut results = thread::scope(|s| {
        let a = s.spawn(|| l.start_session(&session, HOST_ID));
        let b = s.spawn(|| l.start_session(&session, HOST_ID));
        two_opens_started.wait();
        allow_room_open.open();
        vec![a.join().unwrap().is_ok(), b.join().unwrap().is_ok()]
    });
    results.sort_unstable();
    assert_eq!(results, [false, true]);
    let s = l.session(&session).unwrap();
    assert_eq!(
        (s.status.as_str(), s.stream_room.as_deref()),
        ("live", Some("shared-session-room"))
    );
    assert!(closed.lock().unwrap().is_empty());
    assert_eq!(
        *active.lock().unwrap(),
        BTreeSet::from(["shared-session-room".to_owned()])
    );
}

// ── The seat invariants: capacity under a race, the stake and invitation gates, and their failure branches ──────

#[test]
fn concurrent_joins_never_seat_more_than_the_room_holds() {
    let db = db_or_skip!();
    let store = db.store();
    let ports = ports_with(Box::new(NullStream));
    let l = lobbies(&store, &ports, None);
    let room = db.room("capacity-race");
    db.exec(&format!(
        "UPDATE academy.rooms SET capacity = 2 WHERE id = '{room}'"
    ));
    let session = schedule(&l, &room);
    l.start_session(&session, HOST_ID).unwrap();
    let guests: Vec<String> = (0..8)
        .map(|i| format!("55555555-5555-4555-8555-00000000000{i}"))
        .collect();
    let answers: Vec<Result<&str, Refusal>> = thread::scope(|s| {
        let handles: Vec<_> = guests
            .iter()
            .map(|g| s.spawn(|| l.join(&session, g)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let seated = answers.iter().filter(|a| a.is_ok()).count();
    assert_eq!(seated, 2, "{answers:?}");
    assert!(
        answers
            .iter()
            .filter_map(|a| a.as_ref().err())
            .all(|r| code(r) == "academy.room_full")
    );
    assert_eq!(l.occupancy(&session).unwrap(), 2);
    // The host still enters a full room; a repeat join does not take a second seat.
    assert_eq!(l.join(&session, HOST_ID).unwrap(), "host");
    assert_eq!(l.join(&session, HOST_ID).unwrap(), "host");
    assert_eq!(l.occupancy(&session).unwrap(), 3);
    // A seat left is a seat free again.
    let first = guests.iter().find(|g| db.count(&format!("SELECT count(*) FROM academy.session_attendees WHERE user_id = '{g}' AND left_at IS NULL")) == 1).unwrap();
    l.leave(&session, first).unwrap();
    assert_eq!(l.occupancy(&session).unwrap(), 2);
    let late = guests
        .iter()
        .find(|g| {
            *g != first
                && db.count(&format!(
                    "SELECT count(*) FROM academy.session_attendees WHERE user_id = '{g}'"
                )) == 0
        })
        .unwrap();
    // The host's seat counts: two of two are still taken.
    assert_eq!(
        code(&l.join(&session, late).unwrap_err()),
        "academy.room_full"
    );
    l.leave(&session, HOST_ID).unwrap();
    assert_eq!(l.join(&session, late).unwrap(), "attendee");
    assert_eq!(l.occupancy(&session).unwrap(), 2);
}

#[test]
fn the_stake_and_invitation_gates_hold_and_a_down_stake_seats_nobody() {
    let db = db_or_skip!();
    let store = db.store();
    let mut ports = ports_with(Box::new(NullStream));
    let l = lobbies(&store, &ports, None);
    let staked = db.room("staked");
    db.exec(&format!(
        "UPDATE academy.rooms SET access = 'staked', min_stake = 1000 WHERE id = '{staked}'"
    ));
    let session = schedule(&l, &staked);
    l.start_session(&session, HOST_ID).unwrap();
    assert_eq!(
        code(&l.join(&session, GUEST).unwrap_err()),
        "academy.stake_required"
    );
    ports.stake = Box::new(Fixed(parse_amount("1000").unwrap()));
    let l = lobbies(&store, &ports, None);
    assert_eq!(l.join(&session, GUEST).unwrap(), "attendee");
    // The stake source down: refused by its own code, no seat written.
    let other = "66666666-6666-4666-8666-666666666666";
    let (started, finish) = (Arc::new(Gate::default()), Arc::new(Gate::default()));
    finish.open();
    ports.stake = Box::new(HeldStake {
        started,
        finish,
        value: Err(Refusal::Academy(AcademyError::new(
            "Stake gate unavailable (503)",
            "academy.stake_unavailable",
        ))),
    });
    let l = lobbies(&store, &ports, None);
    assert_eq!(
        code(&l.join(&session, other).unwrap_err()),
        "academy.stake_unavailable"
    );
    assert_eq!(l.occupancy(&session).unwrap(), 1);

    let invite = db.room("invite");
    db.exec(&format!(
        "UPDATE academy.rooms SET access = 'invite' WHERE id = '{invite}'"
    ));
    let session = schedule(&l, &invite);
    l.start_session(&session, HOST_ID).unwrap();
    assert_eq!(
        code(&l.join(&session, GUEST).unwrap_err()),
        "academy.invite_required"
    );
    // An expired invitation is no invitation.
    l.invite(
        &invite,
        HOST_ID,
        GUEST,
        Some(at("2026-10-11T00:00:00.000Z")),
    )
    .unwrap();
    assert_eq!(
        code(&l.join(&session, GUEST).unwrap_err()),
        "academy.invite_required"
    );
    assert_eq!(
        code(&l.invite(&invite, GUEST, other, None).unwrap_err()),
        "academy.not_host"
    );
    l.invite(&invite, HOST_ID, GUEST, None).unwrap();
    assert_eq!(l.join(&session, GUEST).unwrap(), "attendee");
    assert_eq!(db.count(&format!("SELECT count(*) FROM academy.room_invites WHERE room_id = '{invite}' AND used_at IS NOT NULL")), 1);
    // A join on a session that is not live seats nobody.
    let scheduled = schedule(&l, &invite);
    assert_eq!(
        code(&l.join(&scheduled, HOST_ID).unwrap_err()),
        "academy.session_not_live"
    );
    assert_eq!(l.occupancy(&scheduled).unwrap(), 0);
}

// ── lobbies/room-pinned-lessons.db.test.ts ───────────────────────────────────────────────────────────────────────

const OTHER: &str = "33333333-3333-4333-8333-333333333334";

fn slugs(l: &Lobbies<'_>, room: &str) -> Vec<String> {
    l.pinned_lessons(room)
        .unwrap()
        .iter()
        .map(|s| s.slug.clone())
        .collect()
}

fn pin_room(l: &Lobbies<'_>, slug: &str, kind: &str) -> String {
    l.create_room(&NewRoom {
        host_id: HOST_ID.to_owned(),
        slug: slug.to_owned(),
        name: slug.to_owned(),
        kind: kind.to_owned(),
        access: Access::Free,
        min_stake: None,
        capacity: 20.0,
    })
    .unwrap()
    .id
}

#[test]
fn a_specialist_room_page_shows_the_lessons_its_host_pinned() {
    let db = db_or_skip!();
    let store = db.store();
    let ports = ports_with(Box::new(NullStream));
    let max = Json::Number(100.0);
    let l = lobbies(&store, &ports, Some(&max));
    let list = spine::list();
    let (first, second, third) = (
        list[0].slug.clone(),
        list[1].slug.clone(),
        list[2].slug.clone(),
    );

    // Reads the pins back in the order pinned, as the catalogue names them; a repeat pin keeps its place.
    let room = pin_room(&l, "futures-desk", "futures");
    assert!(slugs(&l, &room).is_empty());
    for s in [&second, &first, &second] {
        l.pin_lesson(&room, HOST_ID, s).unwrap();
    }
    assert_eq!(slugs(&l, &room), [second.clone(), first.clone()]);
    assert_eq!(
        l.pinned_lessons(&room).unwrap()[0].summary_json().compact(),
        spine::summary(&second).unwrap().summary_json().compact()
    );

    // Only the host pins or unpins, and nothing changes on a refusal.
    assert_eq!(
        code(&l.pin_lesson(&room, OTHER, &third).unwrap_err()),
        "academy.not_host"
    );
    assert_eq!(
        code(&l.unpin_lesson(&room, OTHER, &first).unwrap_err()),
        "academy.not_host"
    );
    assert_eq!(slugs(&l, &room), [second.clone(), first.clone()]);

    // A lesson the catalogue lacks, and a room that does not exist, refuse and write nothing.
    let before = db.count("SELECT count(*) FROM academy.room_pinned_lessons");
    assert_eq!(
        code(&l.pin_lesson(&room, HOST_ID, "no-such-lesson").unwrap_err()),
        "academy.curriculum_not_found"
    );
    assert_eq!(
        code(
            &l.pin_lesson("33333333-3333-4333-8333-333333333333", HOST_ID, &first)
                .unwrap_err()
        ),
        "academy.room_not_found"
    );
    assert_eq!(
        db.count("SELECT count(*) FROM academy.room_pinned_lessons"),
        before
    );

    // Unpins one lesson and keeps the order of the rest; pins stay with their own room; a re-pin goes to the end.
    db.exec("DELETE FROM academy.room_pinned_lessons");
    let clinic = pin_room(&l, "merchant-clinic", "merchant_clinic");
    for s in [&first, &second, &third] {
        l.pin_lesson(&room, HOST_ID, s).unwrap();
    }
    l.pin_lesson(&clinic, HOST_ID, &third).unwrap();
    l.unpin_lesson(&room, HOST_ID, &second).unwrap();
    l.unpin_lesson(&room, HOST_ID, &second).unwrap();
    assert_eq!(slugs(&l, &room), [first.clone(), third.clone()]);
    assert_eq!(slugs(&l, &clinic), std::slice::from_ref(&third));
    l.pin_lesson(&room, HOST_ID, &second).unwrap();
    assert_eq!(slugs(&l, &room), [first, third, second]);
}

// ── learning/customer.db.test.ts: the caller's seat, upcoming sessions and calendar, through the door ────────────

const SECRET: &str = "an-academy-lobbies-pg-edge-secret-long";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const THEM: &str = "22222222-2222-4222-8222-222222222222";

fn door(store: Store) -> AcademyDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store,
        ports: ports_with(Box::new(NullStream)),
        settings: Settings::empty(),
        now: || at("2026-11-20T00:00:00.000Z"),
    })
    .unwrap()
}

fn get(door: &AcademyDoor, path: &str, input: &str) -> (u16, Json) {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(vec![Json::str("academy:read"), Json::str("academy:write")]),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    let headers = vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    let q: String = input
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let url = format!("/trpc/{path}?input={q}");
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn data(answer: &(u16, Json)) -> &Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer.1.get("result").and_then(|r| r.get("data")).unwrap()
}

fn find<'a>(rows: &'a Json, id: &str) -> &'a Json {
    let Json::Array(rows) = rows else {
        panic!("{rows:?}")
    };
    rows.iter()
        .find(|r| r.get("id") == Some(&Json::str(id)))
        .unwrap()
}

#[test]
fn the_caller_sees_their_seat_upcoming_sessions_and_a_calendar_only_for_that_seat() {
    let db = db_or_skip!();
    let (room, mine, theirs) = (
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    db.exec(&format!(
        "INSERT INTO academy.rooms (id, slug, name, kind, access, min_stake, capacity, host_id)
         VALUES ('{room}', 'desk', 'Desk', 'general', 'free', 0, 8, '{USER}');
         INSERT INTO academy.sessions (id, room_id, title, host_id, status, starts_at) VALUES
           ('{mine}', '{room}', 'My hour', '{USER}', 'scheduled', '2026-12-01T15:30:00Z'),
           ('{theirs}', '{room}', 'Their hour', '{THEM}', 'scheduled', '2026-12-02T15:30:00Z');
         INSERT INTO academy.session_attendees (session_id, user_id, role) VALUES
           ('{mine}', '{USER}', 'attendee'), ('{theirs}', '{THEM}', 'host');"
    ));
    let door = door(db.store());
    let room_read = get(
        &door,
        "room",
        &format!(r#"{{"roomId":"{room}","limit":10}}"#),
    );
    let read = data(&room_read);
    let r = read.get("room").unwrap();
    assert_eq!(
        (r.get("seated"), r.get("role")),
        (Some(&Json::Bool(true)), Some(&Json::str("attendee")))
    );
    let sessions = read.get("sessions").unwrap();
    assert_eq!(find(sessions, mine).get("seated"), Some(&Json::Bool(true)));
    assert_eq!(
        find(sessions, mine).get("role"),
        Some(&Json::str("attendee"))
    );
    assert_eq!(
        find(sessions, theirs).get("seated"),
        Some(&Json::Bool(false))
    );
    assert_eq!(find(sessions, theirs).get("role"), Some(&Json::Null));
    let session_read = get(&door, "session", &format!(r#"{{"sessionId":"{theirs}"}}"#));
    let s = data(&session_read).get("session").unwrap();
    assert_eq!(
        (s.get("seated"), s.get("role")),
        (Some(&Json::Bool(false)), Some(&Json::Null))
    );
    let upcoming = get(&door, "myUpcomingSessions", r#"{"limit":10}"#);
    let Json::Array(rows) = data(&upcoming) else {
        panic!()
    };
    assert_eq!(
        rows.iter()
            .map(|r| r.get("id").unwrap().compact())
            .collect::<Vec<_>>(),
        [Json::str(mine).compact()]
    );
    let calendar = get(
        &door,
        "sessionCalendar",
        &format!(r#"{{"sessionId":"{mine}"}}"#),
    );
    let Some(Json::String(text)) = data(&calendar).get("calendar") else {
        panic!()
    };
    for part in [
        "BEGIN:VCALENDAR",
        "DTSTART:20261201T153000Z",
        "X-WR-TIMEZONE:UTC",
    ] {
        assert!(text.contains(part), "{text}");
    }
    let refused = get(
        &door,
        "sessionCalendar",
        &format!(r#"{{"sessionId":"{theirs}"}}"#),
    );
    assert!(
        refused.1.compact().contains(r#""code":"NOT_FOUND""#),
        "{}",
        refused.1.compact()
    );
    let _ = Value::Undefined;
}
