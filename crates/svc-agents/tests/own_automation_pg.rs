//! The own-runs slice's schedules, triggers and background test runs against a real Postgres
//! (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in
//! its own throwaway database migrated by the crate's own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it
//! fails.
//!
//! Ported case for case, through the `AgentsDoor` with signed principals, and `tick_schedules` /
//! `deliver_trigger_event` as `index.ts`'s workers and consumer call them:
//! - `services/svc-agents/src/own/automation.test.ts`, every database case (its pure cases are `src/own/automation.rs`'s
//!   unit tests). The #8326 case's interleaving (the TypeScript wraps `sql.begin` and `runtime.think`) is made with the
//!   slice's `Pause` hooks.
//! - `services/svc-agents/src/own/self-freeze.test.ts`, the halves of its #2 and fail-closed cases that reach
//!   `own.schedules.create`, `own.triggers.create`, `own.session.open` and the schedule workers. The other calls those
//!   cases make (`own.identity.*`, `own.consents.*`, `own.access.grant`, `own.policy.*`) and the freeze event's consumer
//!   (#1, #4) are own-controls' and own-sharing's, owed there.
//! - `services/svc-agents/src/fleet/control.db.test.ts`, "stops a background run at its next step once the agent is
//!   quarantined, and refuses a new one as disabled", with one case more for the kind kill's stop code and a finished
//!   run.
//!
//! Done in SQL as the call writes it, because its slice is not ported: `own.limits.set` (own-controls) and an
//! operator's quarantine and kind kill (`fleet.*`, ops). The freeze read is a fake that can be open, frozen or down,
//! or absent; the ledger is an empty `MemoryLedger`, which books
//! a window's earn and refuses its collect for funds; the bus is a list.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::db::{self, Store};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{MockOptions, MockProvider, Provider};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::parse_routing_table;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::own::Own;
use svc_agents::own::automation::{
    AutoRuns, Cadence, Pause, TriggerEvent, deliver_trigger_event, schedule_run_key, tick_schedules,
};
use svc_agents::own::background::{self, Settings};
use svc_agents::runtime::{Rt, Runtime};
use svc_agents::self_freeze::{
    OWNER_FREEZE_UNREAD, OWNER_FROZEN_SELF, Reading, SelfFreezeRead, Unavailable,
};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SECRET: &str = "an-agents-own-automation-test-secret-of-32-plus!";
const SERVICE_SECRET: &str = "an-agents-own-automation-service-secret-32-plus!";
const SID: &str = "55555555-5555-4555-8555-555555555555";
const PERSON: [&str; 3] = ["agents:read", "agents:execute", "identity:write"];
const FEE: &str = "USDT";
const SINCE: &str = "2026-11-01T00:00:00.000Z";
const CADENCE: Cadence = Cadence {
    min_interval_minutes: Some(1),
    daily_limit: Some(100),
};
const FILL_SETTLED: &str = "intafaced.trade.fill.settled";
const TABLE: &str = r#"{"routes":[
  {"task":"own.run","providerId":"primary","model":"reasoning-md","maxOutputTokens":2048,"price":{"inputPerMillion":"1","outputPerMillion":"5"}}]}"#;

// ── The fakes ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum FreezeState {
    Open,
    Frozen,
    Down,
}

/// `MemorySelfFreezeRead`: open, the person frozen since `SINCE`, or identity down (`down = true`).
#[derive(Clone)]
struct Freeze(Arc<Mutex<FreezeState>>);

impl Freeze {
    fn new(s: FreezeState) -> Freeze {
        Freeze(Arc::new(Mutex::new(s)))
    }
    fn set(&self, s: FreezeState) {
        *self.0.lock().unwrap() = s;
    }
}

impl SelfFreezeRead for Freeze {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable> {
        match *self.0.lock().unwrap() {
            FreezeState::Down => Err(Unavailable("TEST identity down".to_owned())),
            FreezeState::Frozen if user_id == USER => Ok(Reading::Frozen {
                since: Some(SINCE.to_owned()),
            }),
            _ => Ok(Reading::Open),
        }
    }
}

/// `MemoryEventBus`.
#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<String>>>);
impl Bus for FakeBus {
    fn publish(&self, subject: &str, _msg_id: &str, _envelope: &Json) -> Result<(), String> {
        self.0.lock().unwrap().push(subject.to_owned());
        Ok(())
    }
}

/// `new MemoryLedger()`, as the TypeScript suite builds it: nobody holds a balance in it, so a window's earn is booked
/// once under its key and its collect (or a custodial fee charge) is refused for funds. The window stays unpaid and
/// the session open, as the TypeScript's does.
#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<BTreeMap<String, String>>>);
impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        if !matches!(recipe, Recipe::ChargeEarn { .. }) {
            return Err(LedgerError {
                code: Some("ledger.insufficient_funds".to_owned()),
                message: "Insufficient funds".to_owned(),
            });
        }
        let mut b = self.0.lock().unwrap();
        let n = b.len() + 1;
        Ok(b.entry(recipe.idempotency_key())
            .or_insert_with(|| format!("tx-{n}"))
            .clone())
    }
}

// ── The world ───────────────────────────────────────────────────────────────

struct World {
    db: TestDb,
    store: Store,
    gateway: Arc<Gateway>,
    bus: FakeBus,
    ledger: FakeLedger,
    m: Metering,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let provider = Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                ..MockOptions::default()
            },
            system_now,
        ));
        let gateway = Arc::new(Gateway::new(
            vec![provider as Arc<dyn Provider>],
            parse_routing_table(TABLE).unwrap(),
        ));
        let mut w = World {
            store: db::open(&db.url, "svc-agents", 8, false).unwrap(),
            db,
            gateway,
            bus: FakeBus::default(),
            ledger: FakeLedger::default(),
            m: Metering::unwired(FEE, 60),
        };
        w.m = w.metering();
        Some(w)
    }

    fn metering(&self) -> Metering {
        let mut m = Metering::unwired(FEE, 60);
        m.enabled = true;
        m.bus = Box::new(self.bus.clone());
        m.ledger = Box::new(self.ledger.clone());
        m
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// `new AgentRuntime(...)` with the spend gate, and the freeze read given (none: not wired).
    fn runtime(freeze: Option<&Freeze>) -> Runtime {
        let mut r = Runtime::unwired();
        r.self_freeze = freeze.map(|f| Box::new(f.clone()) as Box<dyn SelfFreezeRead>);
        r
    }

    /// `createAgentsRouter({ ..., ownCadence: CADENCE, selfFreeze })`, with the background values given.
    fn people(&self, freeze: Option<&Freeze>, bg: Settings) -> People {
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mut own = Own::unwired();
        own.cadence = CADENCE;
        own.background = bg;
        let door = AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(SERVICE_SECRET.to_owned()),
                keys: None,
            },
            env,
            now: system_now,
            store: db::open(&self.db.url, "svc-agents", 8, false).unwrap(),
            gateway: GatewaySlice {
                gateway: self.gateway.clone(),
                fee_asset_id: FEE.to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: self.metering(),
            runtime: World::runtime(freeze),
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            own,
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap();
        People { door }
    }

    fn open(&self) -> People {
        self.people(Some(&Freeze::new(FreezeState::Open)), Settings::default())
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.client().query_one(sql, &[]).unwrap().get(0)
    }

    fn sql(&self, sql: &str, args: &[&(dyn postgres::types::ToSql + Sync)]) {
        self.db.client().execute(sql, args).unwrap();
    }

    /// `completions()`: the engine runs that were executed.
    fn completions(&self) -> i64 {
        self.count(
            "SELECT count(*)::bigint FROM agents.agent_actions WHERE kind = 'completion' AND status = 'executed'",
        )
    }

    /// A text Postgres reads as a time: now, or `offset` from it.
    fn pg_time(&self, expr: &str) -> String {
        self.db
            .client()
            .query_one(&format!("SELECT ({expr})::text"), &[])
            .unwrap()
            .get(0)
    }
}

/// The `AutoRunDeps` the workers and the consumer run with.
fn auto_runs<'a>(
    w: &'a World,
    rt: &'a Runtime,
    cadence: Cadence,
    pause: Option<&'a dyn Pause>,
) -> AutoRuns<'a> {
    AutoRuns {
        x: Rt {
            rt,
            pool: w.pool(),
            gateway: &w.gateway,
            m: &w.m,
            now: system_now(),
        },
        cadence,
        log: None,
        pause,
    }
}

macro_rules! world_or_skip {
    () => {
        match World::new() {
            Some(w) => w,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── The door ────────────────────────────────────────────────────────────────

fn principal_headers(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str(SID)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

/// What a call answered: its data, or its error's tRPC code and message.
#[derive(Debug, Clone, PartialEq)]
enum Answer {
    Data(Json),
    Refused { code: String, message: String },
}

impl Answer {
    fn data(self) -> Json {
        match self {
            Answer::Data(d) => d,
            Answer::Refused { code, message } => panic!("refused {code}: {message}"),
        }
    }
    fn refused(&self) -> (String, String) {
        match self {
            Answer::Refused { code, message } => (code.clone(), message.clone()),
            Answer::Data(d) => panic!("not refused: {}", d.compact()),
        }
    }
}

fn answer_of(status: u16, body: &str) -> Answer {
    let body = json::parse(body).unwrap();
    if status == 200 {
        return Answer::Data(body.get("result").unwrap().get("data").unwrap().clone());
    }
    let err = body.get("error").unwrap();
    Answer::Refused {
        code: text(err.get("data").unwrap(), "code"),
        message: text(err, "message"),
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.get(key)
        .unwrap_or_else(|| panic!("no {key} in {}", v.compact()))
}

fn list(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not a list: {}", other.compact()),
    }
}

fn num(v: &Json, key: &str) -> i64 {
    match get(v, key) {
        Json::Number(n) => {
            #[allow(clippy::cast_possible_truncation, reason = "a small count")]
            let n = *n as i64;
            n
        }
        other => panic!("{key} is not a number: {other:?}"),
    }
}

/// The router, as the person and another person call it.
struct People {
    door: AgentsDoor,
}

impl People {
    fn query(&self, user: &str, path: &str, input: &Json) -> Answer {
        let url = format!("/trpc/{path}?input={}", enc(&input.compact()));
        let res = self.door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &principal_headers(user, &PERSON),
            body: "",
        });
        answer_of(res.status, &res.body)
    }

    fn mutate(&self, user: &str, path: &str, input: &Json) -> Answer {
        let mut headers = principal_headers(user, &PERSON);
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let body = input.compact();
        let res = self.door.handle(&Request {
            method: "POST",
            url: &format!("/trpc/{path}"),
            headers: &headers,
            body: &body,
        });
        answer_of(res.status, &res.body)
    }

    /// `agent(person, { limits })`: a saved agent with its own cap of 1, and the person's caps for it unless left out.
    fn agent(&self, w: &World, limits: bool) -> String {
        let created = self
            .mutate(
                USER,
                "own.create",
                &Json::obj([
                    ("template", Json::str("service-starter")),
                    (
                        "createKey",
                        Json::str(format!(
                            "auto:{}",
                            svc_agents::metering::settle::random_uuid().unwrap()
                        )),
                    ),
                ]),
            )
            .data();
        let id = text(&created, "id");
        self.mutate(
            USER,
            "own.save",
            &Json::obj([
                ("id", Json::str(id.clone())),
                ("name", Json::str("TEST helper")),
                ("instructions", Json::str("")),
                ("tools", Json::Array(Vec::new())),
                ("perSessionCap", Json::str("1")),
            ]),
        )
        .data();
        if limits {
            // `own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' })` (own-controls), its row.
            w.sql(
                "INSERT INTO agents.own_agent_limits (agent_id, owner_id, per_call, per_session, per_period, period)
                 VALUES ($1::text::uuid, $2::text, 0.012, 0.02, 5, 'month')",
                &[&id, &USER],
            );
        }
        id
    }

    fn schedule(&self, id: &str, key: &str, repeat: &str, interval: &str, cap: &str) -> Answer {
        self.mutate(
            USER,
            "own.schedules.create",
            &Json::obj([
                ("id", Json::str(id)),
                ("createKey", Json::str(key)),
                ("repeat", Json::str(repeat)),
                ("intervalMinutes", Json::str(interval)),
                ("perRunCap", Json::str(cap)),
                ("ask", Json::str("TEST check")),
            ]),
        )
    }

    fn trigger(&self, id: &str, key: &str, subject: &str) -> Answer {
        self.mutate(
            USER,
            "own.triggers.create",
            &Json::obj([
                ("id", Json::str(id)),
                ("createKey", Json::str(key)),
                ("subject", Json::str(subject)),
                ("perRunCap", Json::str("0.1")),
                ("ask", Json::str("TEST")),
            ]),
        )
    }

    fn schedules(&self, user: &str, id: &str) -> Answer {
        self.query(
            user,
            "own.schedules.list",
            &Json::obj([("id", Json::str(id))]),
        )
    }

    fn schedule_list(&self, id: &str) -> Vec<Json> {
        list(get(&self.schedules(USER, id).data(), "schedules")).to_vec()
    }

    fn triggers(&self, id: &str) -> Vec<Json> {
        list(
            &self
                .query(
                    USER,
                    "own.triggers.list",
                    &Json::obj([("id", Json::str(id))]),
                )
                .data(),
        )
        .to_vec()
    }
}

fn by_id<'a>(rows: &'a [Json], id: &str) -> &'a Json {
    rows.iter().find(|r| text(r, "id") == id).unwrap()
}

fn fill<'a>(event_id: &'a str, envelope: &'a str, user: &'a str, at: &'a str) -> TriggerEvent<'a> {
    TriggerEvent {
        subject: FILL_SETTLED,
        user_id: user,
        event_id,
        envelope_id: envelope,
        occurred_at: at,
    }
}

// ── automation.test.ts: schedules through the service (J-agents-07 #1 #2 #4) ─

/// "refuses a repeating schedule with the interval blank and stores none (#1)".
#[test]
fn refuses_a_repeating_schedule_with_the_interval_blank_and_stores_none() {
    let w = world_or_skip!();
    let p = w.open();
    let id = p.agent(&w, true);
    let refused = p.schedule(&id, "sched:blank:1", "repeat", "", "0.1");
    assert_eq!(
        refused.refused(),
        (
            "BAD_REQUEST".to_owned(),
            "agents.schedule.min_interval_unset".to_owned()
        )
    );
    assert!(p.schedule_list(&id).is_empty());
}

/// "two workers waking together make one run of the occurrence; a blank cap per run skips with the reason (#2)".
#[test]
fn two_workers_waking_together_make_one_run_and_a_blank_cap_per_run_skips_with_the_reason() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let deps = auto_runs(&w, &rt, CADENCE, None);
    let id = p.agent(&w, true);
    let capped = p
        .schedule(&id, "sched:capped:1", "repeat", "60", "0.1")
        .data();
    let blank = p.schedule(&id, "sched:blank:2", "once", "", "").data();
    assert_eq!(get(&blank, "perRunCap"), &Json::Null);
    // The same create key again is the same schedule.
    let again = p
        .schedule(&id, "sched:capped:1", "repeat", "60", "0.1")
        .data();
    assert_eq!(text(&again, "id"), text(&capped, "id"));

    tick_schedules(&deps, 2).unwrap();
    tick_schedules(&deps, 2).unwrap(); // nothing is due again for an hour
    let schedules = p.schedule_list(&id);
    let ran = by_id(&schedules, &text(&capped, "id"));
    assert_eq!(text(ran, "state"), "active");
    let recent = list(get(ran, "recent"));
    assert_eq!(recent.len(), 1);
    let occurrence = &recent[0];
    assert_eq!(num(occurrence, "ordinal"), 1);
    assert_eq!(text(occurrence, "state"), "ran");
    assert_eq!(num(occurrence, "runs"), 1);
    assert_eq!(num(occurrence, "wakes"), 2);
    assert_eq!(
        text(occurrence, "runKey"),
        schedule_run_key(&text(&capped, "id"), 1)
    );
    assert_eq!(get(occurrence, "code"), &Json::Null);
    let next_far: bool =
        w.db.client()
            .query_one(
                "SELECT $1::text::timestamptz > now() + interval '59 minutes'",
                &[&text(ran, "nextDueAt")],
            )
            .unwrap()
            .get(0);
    assert!(next_far);
    let skipped = by_id(&schedules, &text(&blank, "id"));
    assert_eq!(text(skipped, "state"), "completed");
    assert_eq!(get(skipped, "nextDueAt"), &Json::Null);
    let recent = list(get(skipped, "recent"));
    assert_eq!(recent.len(), 1);
    assert_eq!(text(&recent[0], "state"), "skipped");
    assert_eq!(text(&recent[0], "code"), "agents.schedule_blocked");
    assert_eq!(
        text(&recent[0], "reasonCode"),
        "agents.schedule.cap_per_run_unset"
    );
    assert_eq!(num(&recent[0], "runs"), 0);
    assert_eq!(get(&recent[0], "sessionId"), &Json::Null);
    assert_eq!(w.completions(), 1);
    // Another person reads the agent as not found.
    assert_eq!(
        p.schedules(OTHER, &id).refused(),
        ("NOT_FOUND".to_owned(), "agents.own.not_found".to_owned())
    );
}

/// "skips with the person's caps for the agent unset, and runs nothing".
#[test]
fn skips_with_the_persons_caps_for_the_agent_unset_and_runs_nothing() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let deps = auto_runs(&w, &rt, CADENCE, None);
    let id = p.agent(&w, false);
    p.schedule(&id, "sched:nolimits:1", "once", "", "0.1")
        .data();
    tick_schedules(&deps, 1).unwrap();
    let schedules = p.schedule_list(&id);
    let run = &list(get(&schedules[0], "recent"))[0];
    assert_eq!(text(run, "state"), "skipped");
    assert_eq!(text(run, "code"), "agents.schedule_blocked");
    assert_eq!(text(run, "reasonCode"), "agents.spend.cap_unset");
    assert_eq!(w.completions(), 0);
}

/// "resumes a run a crash left claimed once, never twice".
#[test]
fn resumes_a_run_a_crash_left_claimed_once_never_twice() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let deps = auto_runs(&w, &rt, CADENCE, None);
    let id = p.agent(&w, true);
    let schedule = p.schedule(&id, "sched:crash:1", "once", "", "0.1").data();
    tick_schedules(&deps, 1).unwrap();
    assert_eq!(w.completions(), 1);
    // As if the process stopped after the engine call and before the row was settled: claimed, its lease long gone.
    w.sql(
        "UPDATE agents.own_agent_auto_runs SET state = 'claimed', updated_at = now() - interval '1 hour'",
        &[],
    );
    tick_schedules(&deps, 2).unwrap();
    let schedules = p.schedule_list(&id);
    assert_eq!(text(&schedules[0], "id"), text(&schedule, "id"));
    let recent = list(get(&schedules[0], "recent"));
    assert_eq!(recent.len(), 1);
    assert_eq!(text(&recent[0], "state"), "ran");
    assert_eq!(num(&recent[0], "runs"), 1);
    assert_eq!(w.completions(), 1);
}

/// "a cancelled schedule has no next occurrence and none runs when it would have been due (#4)".
#[test]
fn a_cancelled_schedule_has_no_next_occurrence_and_none_runs_when_it_would_have_been_due() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let deps = auto_runs(&w, &rt, CADENCE, None);
    let id = p.agent(&w, true);
    let schedule = p
        .schedule(&id, "sched:cancel:1", "repeat", "1", "0.1")
        .data();
    tick_schedules(&deps, 1).unwrap();
    // Its next occurrence is due now, and it is cancelled before any worker wakes.
    w.sql(
        "UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 second'",
        &[],
    );
    let cancelled = p
        .mutate(
            USER,
            "own.schedules.cancel",
            &Json::obj([
                ("id", Json::str(id.clone())),
                ("scheduleId", Json::str(text(&schedule, "id"))),
            ]),
        )
        .data();
    assert_eq!(text(&cancelled, "state"), "cancelled");
    assert_eq!(get(&cancelled, "nextDueAt"), &Json::Null);
    tick_schedules(&deps, 2).unwrap();
    assert_eq!(list(get(&p.schedule_list(&id)[0], "recent")).len(), 1);
    assert_eq!(w.completions(), 1);
}

// ── automation.test.ts: triggers through the service (J-agents-07 #3) ────────

/// "the same event id twice is one run; a restart does not repeat it".
#[test]
fn the_same_event_id_twice_is_one_run_and_a_restart_does_not_repeat_it() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let deps = auto_runs(&w, &rt, CADENCE, None);
    let id = p.agent(&w, true);
    let trigger = p.trigger(&id, "trigger:1", "trade.fill.settled").data();
    let now = w.pg_time("now()");
    // A fill that settled before the trigger was added, delivered late, never runs it.
    let before = w.pg_time(&format!(
        "'{}'::timestamptz - interval '60 seconds'",
        text(&trigger, "createdAt")
    ));
    assert_eq!(
        deliver_trigger_event(&deps, &fill("fill-0", "env-0", USER, &before)).unwrap(),
        0
    );
    assert_eq!(
        deliver_trigger_event(&deps, &fill("fill-1", "env-1", USER, &now)).unwrap(),
        1
    );
    assert_eq!(
        deliver_trigger_event(&deps, &fill("fill-1", "env-2", USER, &now)).unwrap(),
        0
    );
    // A new process, as after a restart: the seen-set is the table.
    let rt2 = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let restarted = auto_runs(&w, &rt2, CADENCE, None);
    assert_eq!(
        deliver_trigger_event(&restarted, &fill("fill-1", "env-3", USER, &now)).unwrap(),
        0
    );
    // Another person's event never runs this person's trigger.
    assert_eq!(
        deliver_trigger_event(&deps, &fill("fill-1", "env-4", OTHER, &now)).unwrap(),
        0
    );
    let listed = p.triggers(&id);
    assert_eq!(text(&listed[0], "id"), text(&trigger, "id"));
    let runs = list(get(&listed[0], "runs"));
    assert_eq!(runs.len(), 1);
    assert_eq!(text(&runs[0], "eventId"), "fill-1");
    assert_eq!(text(&runs[0], "state"), "ran");
    assert_eq!(num(&runs[0], "runs"), 1);
    let mut deliveries: Vec<(String, bool)> = list(get(&listed[0], "deliveries"))
        .iter()
        .map(|d| {
            (
                text(d, "envelopeId"),
                get(d, "redelivered") == &Json::Bool(true),
            )
        })
        .collect();
    deliveries.sort();
    assert_eq!(
        deliveries,
        vec![
            ("env-1".to_owned(), false),
            ("env-2".to_owned(), true),
            ("env-3".to_owned(), true),
        ]
    );
    assert_eq!(w.completions(), 1);
    assert_eq!(
        p.trigger(&id, "trigger:2", "identity.kyc.approved")
            .refused(),
        (
            "BAD_REQUEST".to_owned(),
            "agents.trigger_subject_invalid".to_owned()
        )
    );
}

fn states(runs: &[Json]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = runs
        .iter()
        .map(|r| (text(r, "eventId"), text(r, "state")))
        .collect();
    out.sort();
    out
}

/// "two fills arriving together cannot both pass a daily limit of one".
#[test]
fn two_fills_arriving_together_cannot_both_pass_a_daily_limit_of_one() {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let limited = auto_runs(
        &w,
        &rt,
        Cadence {
            daily_limit: Some(1),
            ..CADENCE
        },
        None,
    );
    let id = p.agent(&w, true);
    p.trigger(&id, "trigger:limit", "trade.fill.settled").data();
    let now = w.pg_time("now()");
    std::thread::scope(|s| {
        let a =
            s.spawn(|| deliver_trigger_event(&limited, &fill("fill-a", "env-fill-a", USER, &now)));
        let b =
            s.spawn(|| deliver_trigger_event(&limited, &fill("fill-b", "env-fill-b", USER, &now)));
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
    });
    let listed = p.triggers(&id);
    let runs = list(get(&listed[0], "runs"));
    let mut by_state: Vec<String> = runs.iter().map(|r| text(r, "state")).collect();
    by_state.sort();
    assert_eq!(by_state, vec!["ran".to_owned(), "skipped".to_owned()]);
    let skipped = runs.iter().find(|r| text(r, "state") == "skipped").unwrap();
    assert_eq!(
        text(skipped, "reasonCode"),
        "agents.schedule.daily_limit_reached"
    );
    assert_eq!(num(skipped, "runs"), 0);
    assert_eq!(w.completions(), 1);
}

/// A latch one thread opens and others wait on.
#[derive(Default)]
struct Latch(Mutex<bool>, Condvar);
impl Latch {
    fn open(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
    fn wait(&self) {
        let mut open = self.0.lock().unwrap();
        while !*open {
            open = self.1.wait(open).unwrap();
        }
    }
}

/// The TypeScript's `ordered` and `bWaits` proxies: fill a's claim transaction begins first and takes the trigger's
/// lock only once fill b has claimed and committed; b's engine call waits until a's delivery is done.
#[derive(Default)]
struct Ordered {
    a_began: Latch,
    b_claimed: Latch,
    a_delivered: Latch,
}

impl Pause for Ordered {
    fn claim_begun(&self, event_id: &str) {
        if event_id == "fill-a" {
            self.a_began.open();
            self.b_claimed.wait();
        } else {
            self.a_began.wait();
        }
    }
    fn claim_committed(&self, event_id: &str) {
        if event_id == "fill-b" {
            self.b_claimed.open();
        }
    }
    fn before_think(&self, request_id: &str) {
        if request_id.contains("fill-b") {
            self.a_delivered.wait();
        }
    }
}

/// "a fill whose transaction began first but took the lock second still counts the one claimed before it (#8326)".
#[test]
fn a_fill_whose_transaction_began_first_but_took_the_lock_second_still_counts_the_one_claimed_before_it()
 {
    let w = world_or_skip!();
    let p = w.open();
    let rt = World::runtime(Some(&Freeze::new(FreezeState::Open)));
    let ordered = Ordered::default();
    let limited = auto_runs(
        &w,
        &rt,
        Cadence {
            daily_limit: Some(1),
            ..CADENCE
        },
        Some(&ordered),
    );
    let id = p.agent(&w, true);
    p.trigger(&id, "trigger:order", "trade.fill.settled").data();
    let now = w.pg_time("now()");
    std::thread::scope(|s| {
        let a = s.spawn(|| {
            let out = deliver_trigger_event(&limited, &fill("fill-a", "env-fill-a", USER, &now));
            ordered.a_delivered.open();
            out
        });
        // Fill b starts only once a's transaction is open: the first begin is always a's.
        ordered.a_began.wait();
        let b =
            s.spawn(|| deliver_trigger_event(&limited, &fill("fill-b", "env-fill-b", USER, &now)));
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
    });
    let listed = p.triggers(&id);
    let runs = list(get(&listed[0], "runs"));
    assert_eq!(
        states(runs),
        vec![
            ("fill-a".to_owned(), "skipped".to_owned()),
            ("fill-b".to_owned(), "ran".to_owned()),
        ]
    );
    let a = runs
        .iter()
        .find(|r| text(r, "eventId") == "fill-a")
        .unwrap();
    assert_eq!(text(a, "reasonCode"), "agents.schedule.daily_limit_reached");
    assert_eq!(num(a, "runs"), 0);
    assert_eq!(w.completions(), 1);
}

// ── self-freeze.test.ts ─────────────────────────────────────────────────────

/// `equip`'s part this slice owns: an agent with its caps, a repeating schedule due far ahead, and a trigger.
fn equip(w: &World, p: &People) -> (String, String) {
    let id = p.agent(w, true);
    let schedule = p
        .schedule(&id, "sched:freeze:1", "repeat", "60", "0.1")
        .data();
    let schedule_id = text(&schedule, "id");
    // Due far ahead, so the test's own tick decides when it runs.
    w.sql(
        "UPDATE agents.own_agent_schedules SET next_due_at = now() + interval '1 day' WHERE id = $1::text::uuid",
        &[&schedule_id],
    );
    p.trigger(&id, "trig:freeze:1", "trade.fill.settled").data();
    (id, schedule_id)
}

fn live(w: &World) -> (i64, i64, i64) {
    (
        w.count("SELECT count(*)::bigint FROM agents.own_agent_schedules WHERE state = 'active'"),
        w.count("SELECT count(*)::bigint FROM agents.own_agent_triggers WHERE state = 'active'"),
        w.count("SELECT count(*)::bigint FROM agents.agent_sessions"),
    )
}

fn create_schedule_trigger_and_session_refuse(p: &People, id: &str, code: &str) {
    let refused = ("FORBIDDEN".to_owned(), code.to_owned());
    assert_eq!(
        p.schedule(id, "sched:frozen:1", "once", "", "0.1")
            .refused(),
        refused
    );
    assert_eq!(
        p.trigger(id, "trig:frozen:1", "trade.fill.settled")
            .refused(),
        refused
    );
    // An agent order: no session of the agent opens, so nothing runs or trades for the person.
    assert_eq!(
        p.mutate(
            USER,
            "own.session.open",
            &Json::obj([("id", Json::str(id))])
        )
        .refused(),
        refused
    );
}

/// "#2 while frozen ... an agent order, a permission change and a new key are each refused owner_frozen_self, and
/// nothing changes": the new schedule, the new trigger and the session. The key, token, consent, access and policy
/// halves are own-sharing's and own-controls' calls, owed there.
#[test]
fn while_frozen_a_new_schedule_a_new_trigger_and_an_agent_order_are_refused_and_nothing_changes() {
    let w = world_or_skip!();
    let (id, _) = equip(&w, &w.open());
    let before = live(&w);
    let freeze = Freeze::new(FreezeState::Frozen);
    let p = w.people(Some(&freeze), Settings::default());
    create_schedule_trigger_and_session_refuse(&p, &id, OWNER_FROZEN_SELF);
    // Nothing was scheduled or opened.
    assert_eq!(live(&w), before);
}

/// "a scheduled occurrence that comes due while frozen is skipped by the freeze code, and the agent never runs".
#[test]
fn a_scheduled_occurrence_that_comes_due_while_frozen_is_skipped_by_the_freeze_code() {
    let w = world_or_skip!();
    let freeze = Freeze::new(FreezeState::Open);
    let p = w.people(Some(&freeze), Settings::default());
    let (_, schedule_id) = equip(&w, &p);
    w.sql(
        "UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 minute' WHERE id = $1::text::uuid",
        &[&schedule_id],
    );
    freeze.set(FreezeState::Frozen);
    let rt = World::runtime(Some(&freeze));
    tick_schedules(&auto_runs(&w, &rt, CADENCE, None), 1).unwrap();
    let rows =
        w.db.client()
            .query(
                "SELECT state, code, reason_code, session_id::text FROM agents.own_agent_auto_runs",
                &[],
            )
            .unwrap();
    assert_eq!(rows.len(), 1);
    let row: (String, Option<String>, Option<String>, Option<String>) = (
        rows[0].get(0),
        rows[0].get(1),
        rows[0].get(2),
        rows[0].get(3),
    );
    assert_eq!(
        row,
        (
            "skipped".to_owned(),
            Some("agents.schedule_blocked".to_owned()),
            Some(OWNER_FROZEN_SELF.to_owned()),
            None
        )
    );
    assert_eq!(w.completions(), 0);
}

/// "fails closed: identity down, or no freeze read wired, refuses every one owner_freeze_unread and changes nothing":
/// the new schedule, the session and the scheduled run (the other calls are own-sharing's and own-controls').
#[test]
fn fails_closed_identity_down_or_no_freeze_read_wired_refuses_owner_freeze_unread_and_changes_nothing()
 {
    let w = world_or_skip!();
    let (id, schedule_id) = equip(&w, &w.open());
    let before = live(&w);
    let down = Freeze::new(FreezeState::Down);
    for freeze in [Some(&down), None] {
        let p = w.people(freeze, Settings::default());
        let unread = ("FORBIDDEN".to_owned(), OWNER_FREEZE_UNREAD.to_owned());
        assert_eq!(
            p.schedule(&id, "sched:unread:1", "once", "", "0.1")
                .refused(),
            unread
        );
        assert_eq!(
            p.mutate(
                USER,
                "own.session.open",
                &Json::obj([("id", Json::str(id.clone()))])
            )
            .refused(),
            unread
        );
        w.sql("DELETE FROM agents.own_agent_auto_runs", &[]);
        w.sql(
            "UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 minute' WHERE id = $1::text::uuid",
            &[&schedule_id],
        );
        let rt = World::runtime(freeze);
        tick_schedules(&auto_runs(&w, &rt, CADENCE, None), 1).unwrap();
        let rows =
            w.db.client()
                .query(
                    "SELECT state, reason_code FROM agents.own_agent_auto_runs",
                    &[],
                )
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].get::<_, String>(0),
                rows[0].get::<_, Option<String>>(1)
            ),
            ("skipped".to_owned(), Some(OWNER_FREEZE_UNREAD.to_owned()))
        );
        w.sql(
            "UPDATE agents.own_agent_schedules SET next_due_at = now() + interval '1 day' WHERE id = $1::text::uuid",
            &[&schedule_id],
        );
    }
    assert_eq!(live(&w), before);
    assert_eq!(w.completions(), 0);
}

// ── control.db.test.ts: background test runs ───────────────────────────────

const CUSTOMER: &str = USER;
const OWN: &str = "77777777-7777-4777-8777-777777777777";

/// The suite's `beforeEach`: the person's own agent, written as its row.
fn own_agent(w: &World) {
    w.sql(
        "INSERT INTO agents.own_agents (id, owner_id, template, name, create_key, per_session_cap)
         VALUES ($1::text::uuid, $2::text, 'service-starter', 'TEST helper', 'k1', 1)",
        &[&OWN, &CUSTOMER],
    );
}

fn latest(w: &World) -> Json {
    list(&background::list(w.pool(), CUSTOMER, OWN, 5).unwrap())[0].clone()
}

/// "stops a background run at its next step once the agent is quarantined, and refuses a new one as disabled".
#[test]
fn stops_a_background_run_at_its_next_step_once_quarantined_and_refuses_a_new_one_as_disabled() {
    let w = world_or_skip!();
    own_agent(&w);
    let ask = "TEST: check every market one by one";
    let run = background::start(w.pool(), CUSTOMER, OWN, "req-bg-1", ask, 10).unwrap();
    let again = background::start(w.pool(), CUSTOMER, OWN, "req-bg-1", ask, 10).unwrap();
    assert_eq!(text(&again, "id"), text(&run, "id"));
    background::advance(w.pool(), 100).unwrap();
    background::advance(w.pool(), 100).unwrap();
    let first = latest(&w);
    assert_eq!(text(&first, "state"), "running");
    assert_eq!(num(&first, "stepsDone"), 2);
    assert_eq!(text(&first, "cost"), "0");
    assert_eq!(text(&first, "label"), "TEST");

    // `fleet.quarantine({ ref: 'own:<id>', reason })` (ops), as the switch row it writes.
    w.sql(
        "INSERT INTO agents.agent_switches (agent_ref, reason, set_by) VALUES ($1::text, 'TEST quarantine', 'founder-a')",
        &[&format!("own:{OWN}")],
    );
    background::advance(w.pool(), 100).unwrap();
    background::advance(w.pool(), 100).unwrap();
    let stopped = latest(&w);
    assert_eq!(text(&stopped, "state"), "stopped");
    assert_eq!(num(&stopped, "stepsDone"), 2);
    assert_eq!(text(&stopped, "stopCode"), "agents.agent.quarantined");

    let input = |key: &str| {
        Json::obj([
            ("id", Json::str(OWN)),
            ("requestId", Json::str(key)),
            ("ask", Json::str("x")),
        ])
    };
    let set = w.people(
        None,
        Settings {
            steps: Some(10),
            step_ms: Some(1000),
        },
    );
    assert_eq!(
        set.mutate(CUSTOMER, "own.backgroundRun", &input("req-bg-2"))
            .refused(),
        ("FORBIDDEN".to_owned(), "agents.agent.disabled".to_owned())
    );
    let blank = w.people(None, Settings::default());
    assert_eq!(
        blank
            .mutate(CUSTOMER, "own.backgroundRun", &input("req-bg-3"))
            .refused(),
        (
            "PRECONDITION_FAILED".to_owned(),
            "agents.background_unset".to_owned()
        )
    );
}

/// One case more: a run started through the door finishes at its last step and is listed newest first; a kind kill
/// stops another at its next step with the kind's code.
#[test]
fn a_started_run_finishes_at_its_last_step_and_a_kind_kill_stops_another_with_its_code() {
    let w = world_or_skip!();
    own_agent(&w);
    let p = w.people(
        Some(&Freeze::new(FreezeState::Open)),
        Settings {
            steps: Some(2),
            step_ms: Some(1000),
        },
    );
    let start = |key: &str| {
        p.mutate(
            CUSTOMER,
            "own.backgroundRun",
            &Json::obj([
                ("id", Json::str(OWN)),
                ("requestId", Json::str(key)),
                ("ask", Json::str("TEST ask")),
            ]),
        )
        .data()
    };
    let done = start("req-bg-done");
    assert_eq!(text(&done, "state"), "running");
    assert_eq!(num(&done, "stepsTotal"), 2);
    assert_eq!(text(&done, "mode"), "test");
    background::advance(w.pool(), 100).unwrap();
    background::advance(w.pool(), 100).unwrap();
    background::advance(w.pool(), 100).unwrap();
    let killed = start("req-bg-kind");
    w.sql(
        "INSERT INTO agents.agent_kind_switches (kind, reason, set_by) VALUES ('customer_built', 'TEST kind kill', 'founder-a')",
        &[],
    );
    background::advance(w.pool(), 100).unwrap();
    let runs = p
        .query(
            CUSTOMER,
            "own.backgroundRuns",
            &Json::obj([("id", Json::str(OWN)), ("limit", Json::int(5))]),
        )
        .data();
    let runs = list(&runs);
    assert_eq!(runs.len(), 2);
    let finished = by_id(runs, &text(&done, "id"));
    assert_eq!(text(finished, "state"), "done");
    assert_eq!(num(finished, "stepsDone"), 2);
    let stopped = by_id(runs, &text(&killed, "id"));
    assert_eq!(text(stopped, "state"), "stopped");
    assert_eq!(num(stopped, "stepsDone"), 0);
    assert_eq!(text(stopped, "stopCode"), "agents.agent.disabled_by_kind");
}
