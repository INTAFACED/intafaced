//! The \`runtime\` slice's thinking half against a real Postgres (\`TEST_DATABASE_URL_AGENTS\` or \`TEST_DATABASE_URL\`, a
//! server whose admin database name ends in \`_test\`), each test in its own throwaway database migrated by the crate's
//! own runner. Without a URL it skips; with \`REQUIRE_POSTGRES=1\` it fails.
//!
//! The cases of \`services/svc-agents/src/runtime.test.ts\` that drive \`think\`, sessions, spend holds and the action
//! log, ported case for case onto \`svc_agents::runtime\` (each test names its source): per-task routing, the guardrail
//! and spend-hold cases, the action log, provider failure and the events. The provider is the crate's deterministic
//! mock (wrapped where the TypeScript wraps the gateway), the ledger a double-entry fake that books each recipe once per
//! key as \`MemoryLedger\` does, and the bus an in-memory list. The cases that run a tool (\`runtime.act\`) are
//! \`tests/runtime_act_pg.rs\`'s.
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
use std::time::Duration;

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::{Instant, js_date};
use support::TestDb;
use svc_agents::audit::{self, Action};
use svc_agents::boot::{BootAgent, register_agents};
use svc_agents::db::Store;
use svc_agents::door::system_now;
use svc_agents::gateway::Gateway;
use svc_agents::gateway::providers::{
    ChatMessage, CompletionRequest, CompletionResult, EmbedRequest, EmbedResult, Failure, Health,
    MockOptions, MockProvider, Provider, ProviderError, Role, TokenUsage, mock_input_tokens,
    mock_output_tokens,
};
use svc_agents::gateway::routing::{Capability, Engine, Route, RoutingTable, parse_routing_table};
use svc_agents::metering::Metering;
use svc_agents::metering::meter;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::metering::settle;
use svc_agents::metering::spend::{self, SetInput};
use svc_agents::runtime::guardrails::{Refusal, parse_guardrail, serialise_guardrail};
use svc_agents::runtime::holds::{self, ReserveInput};
use svc_agents::runtime::{
    self, ACTION_COMPLETED, ACTION_REJECTED, Rt, RunError, Runtime, SessionRecord, ThinkInput,
    ThinkResult, estimate_input_tokens, usage_cost,
};

const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const FEE: &str = "IFC";

/// The TypeScript's \`TABLE\`: model values are aliases, prices exact at these token counts.
const TABLE: &str = r#"{"routes":[
  {"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":256,"price":{"inputPerMillion":"3","outputPerMillion":"15"}},
  {"task":"quick","providerId":"primary","model":"fast-sm","maxOutputTokens":64,"price":{"inputPerMillion":"0.25","outputPerMillion":"1.25"}},
  {"task":"vectors","providerId":"primary","model":"embed-sm","maxOutputTokens":1,"price":{"inputPerMillion":"0.1","outputPerMillion":"0"},"capability":"embed"},
  {"task":"orphan","providerId":"nowhere","model":"reasoning-lg","maxOutputTokens":16,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}
]}"#;

fn table() -> RoutingTable {
    parse_routing_table(TABLE).unwrap()
}

fn route(task: &str) -> Route {
    table().routes.into_iter().find(|r| r.task == task).unwrap()
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// \`PROBE\` (and its variants): \`trade.quote\` read, \`trade.order\` write with approval and a budget of one.
fn guardrail(agent_id: &str, version: i64, max_spend: Option<&str>, extra_tool: &str) -> Json {
    let spend = max_spend.map_or_else(|| "null".to_owned(), |s| format!("\"{s}\""));
    json::parse(&format!(
        r#"{{"agentId":"{agent_id}","version":{version},"capacityMode":"confirm_each",
            "tools":[{{"name":"trade.quote","module":"trade","mode":"read"}},
                     {{"name":"trade.order","module":"trade","mode":"write","maxCallsPerSession":1,"requiresApproval":true}}{extra_tool}],
            "limits":{{"maxActionsPerSession":20,"maxOutputTokensPerCall":256,"maxSpendPerSession":{spend},
                       "allowedModules":["trade"],"allowedTasks":["plan","quick","orphan"]}}}}"#
    ))
    .unwrap()
}

const CLOSE_TOOL: &str = r#",{"name":"trade.close","module":"trade","mode":"write"}"#;

fn messages(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.to_owned(),
    }]
}

const STAKE: &str = "Where do I stake?";

/// \`expectedUsage\`: the exact usage the mock reports for a task, computed from the request, not from the code.
fn expected_usage(task: &str, max_output_tokens: Option<i64>) -> (Route, TokenUsage) {
    let r = route(task);
    let request = CompletionRequest {
        model: r.model.clone(),
        system: None,
        messages: messages(STAKE),
        max_output_tokens: max_output_tokens
            .map_or(r.max_output_tokens, |m| m.min(r.max_output_tokens)),
        temperature: None,
        stop_sequences: None,
    };
    let usage = TokenUsage {
        input_tokens: mock_input_tokens(&request),
        output_tokens: mock_output_tokens(&request),
    };
    (r, usage)
}

fn cost_of(r: &Route, usage: TokenUsage) -> Amount {
    usage_cost(usage.input_tokens, usage.output_tokens, &r.price.unwrap()).unwrap()
}

/// The route's worst case at its ceiling (or \`output\` tokens), as the hold reserves it.
fn worst_of(task: &str, output: Option<i64>) -> Amount {
    let r = route(task);
    usage_cost(
        estimate_input_tokens(None, &messages(STAKE)),
        output.unwrap_or(r.max_output_tokens),
        &r.price.unwrap(),
    )
    .unwrap()
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// \`MemoryLedger\` as far as these tests read it: double entry, each recipe booked once under its key.
#[derive(Default)]
struct Book {
    by_key: BTreeMap<String, String>,
    accounts: BTreeMap<String, Amount>,
}

#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<Book>>);

fn available_account(user: &str) -> String {
    format!("user:{user}:available:{FEE}")
}

impl FakeLedger {
    /// \`recipes.deposit\`: the user's available up, the rail's down.
    fn deposit(&self, user: &str, amount: Amount) {
        let mut b = self.0.lock().unwrap();
        *b.accounts.entry(available_account(user)).or_default() += amount;
        *b.accounts.entry(format!("rail:test:{FEE}")).or_default() -= amount;
    }
    fn balance(&self, account: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .accounts
            .get(account)
            .copied()
            .unwrap_or(0)
    }
    /// \`balanceOf(userId)\`.
    fn available(&self, user: &str) -> String {
        format_amount(self.balance(&available_account(user)))
    }
    /// \`houseOf()\`: \`houseFees('agents', 'IFC')\`.
    fn house(&self) -> String {
        format_amount(self.balance(&format!("house:fees:agents:{FEE}")))
    }
    /// \`ledger.totalsByAsset().IFC\`: every account summed; double entry nets to zero.
    fn totals(&self) -> String {
        format_amount(self.0.lock().unwrap().accounts.values().sum())
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.by_key.get(&key) {
            return Ok(tx.clone());
        }
        let Recipe::FeeCharge {
            user_id,
            module,
            asset_id,
            amount,
            ..
        } = recipe
        else {
            return Err(LedgerError {
                code: None,
                message: "this suite books only the custodial fee charge".to_owned(),
            });
        };
        let from = format!("user:{user_id}:available:{asset_id}");
        if b.accounts.get(&from).copied().unwrap_or(0) < *amount {
            return Err(LedgerError {
                code: Some("ledger.insufficient_funds".to_owned()),
                message: format!("Insufficient funds: requested {}", format_amount(*amount)),
            });
        }
        *b.accounts.entry(from).or_default() -= amount;
        *b.accounts
            .entry(format!("house:fees:{module}:{asset_id}"))
            .or_default() += amount;
        let tx = format!("tx-{}", b.by_key.len() + 1);
        b.by_key.insert(key, tx.clone());
        Ok(tx)
    }
}

/// \`MemoryEventBus\`: what was published, in order.
#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<(String, Json)>>>);

impl FakeBus {
    fn emitted(&self, subject: &str) -> Vec<Json> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == subject)
            .map(|(_, e)| e.get("payload").unwrap().clone())
            .collect()
    }
    fn serialised(&self) -> String {
        Json::Array(
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(_, e)| e.clone())
                .collect(),
        )
        .compact()
    }
}

impl Bus for FakeBus {
    fn publish(&self, subject: &str, _msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((subject.to_owned(), envelope.clone()));
        Ok(())
    }
}

/// \`gateComplete\`: holds the engine call so two thinks overlap. \`First\` holds only the first entry; \`Both\` waits
/// until two have entered, then lets them through together.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    First,
    Both,
}

#[derive(Default)]
struct GateState {
    entered: usize,
    ready: bool,
    released: bool,
}

struct Gated {
    inner: Arc<MockProvider>,
    mode: Mode,
    state: Arc<(Mutex<GateState>, Condvar)>,
}

const GATE_WAIT: Duration = Duration::from_secs(10);

impl Gated {
    fn new(inner: &Arc<MockProvider>, mode: Mode) -> Arc<Gated> {
        Arc::new(Gated {
            inner: Arc::clone(inner),
            mode,
            state: Arc::new((Mutex::new(GateState::default()), Condvar::new())),
        })
    }
    fn entered(&self) -> usize {
        self.state.0.lock().unwrap().entered
    }
    fn wait_ready(&self) {
        let (lock, cv) = &*self.state;
        let g = lock.lock().unwrap();
        let (g, timeout) = cv.wait_timeout_while(g, GATE_WAIT, |g| !g.ready).unwrap();
        assert!(
            !timeout.timed_out() && g.ready,
            "the gate was never reached"
        );
    }
    fn release(&self) {
        let (lock, cv) = &*self.state;
        lock.lock().unwrap().released = true;
        cv.notify_all();
    }
}

impl Provider for Gated {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn capabilities(&self) -> &[Capability] {
        self.inner.capabilities()
    }
    fn engine(&self) -> Engine {
        self.inner.engine()
    }
    fn health(&self, now: Instant) -> Health {
        self.inner.health(now)
    }
    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        {
            let (lock, cv) = &*self.state;
            let mut g = lock.lock().unwrap();
            g.entered += 1;
            let hold = match self.mode {
                Mode::First => g.entered == 1,
                Mode::Both => true,
            };
            if (self.mode == Mode::First && g.entered == 1)
                || (self.mode == Mode::Both && g.entered >= 2)
            {
                g.ready = true;
                cv.notify_all();
            }
            if hold {
                let _ = cv
                    .wait_timeout_while(g, GATE_WAIT, |g| !g.released)
                    .unwrap();
            }
        }
        self.inner.complete(request)
    }
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        self.inner.embed(request)
    }
}

/// The over-cap gateway: the engine reports a million output tokens more than it was allowed, and a secret text.
struct Inflating(Arc<MockProvider>);

impl Provider for Inflating {
    fn id(&self) -> &str {
        self.0.id()
    }
    fn capabilities(&self) -> &[Capability] {
        self.0.capabilities()
    }
    fn engine(&self) -> Engine {
        self.0.engine()
    }
    fn health(&self, now: Instant) -> Health {
        self.0.health(now)
    }
    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        let mut done = self.0.complete(request)?;
        done.usage.output_tokens += 1_000_000;
        done.text = "over-cap secret".to_owned();
        Ok(done)
    }
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        self.0.embed(request)
    }
}

fn mock(fail_first: u32) -> Arc<MockProvider> {
    Arc::new(MockProvider::new(
        MockOptions {
            id: Some("primary".to_owned()),
            fail_first,
            ..MockOptions::default()
        },
        system_now,
    ))
}

fn down() -> ProviderError {
    ProviderError {
        message: "upstream is down".to_owned(),
        provider_id: "primary".to_owned(),
        retryable: true,
        status: Some(503),
    }
}

// ── The world a test runs in (\`beforeEach\`) ─────────────────────────────────

struct World {
    db: TestDb,
    store: Store,
    ledger: FakeLedger,
    bus: FakeBus,
    provider: Arc<MockProvider>,
    gateway: Gateway,
    /// \`meteringEnabled: true\`.
    m: Metering,
    /// \`meteringEnabled: false\`, the same ledger and bus.
    unbilled: Metering,
    /// \`new AgentRuntime(sql, gateway, meter, bus, { feeAssetId, meteringEnabled: true })\`: no spend gate.
    plain: Runtime,
    /// The same with \`spend: new UserSpendStore(sql)\`.
    gated: Runtime,
}

fn runtime_with(spend: bool) -> Runtime {
    let mut r = Runtime::unwired();
    r.spend = spend;
    r
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let ledger = FakeLedger::default();
        let bus = FakeBus::default();
        let metering = |enabled: bool| {
            let mut m = Metering::unwired(FEE, 60);
            m.enabled = enabled;
            m.ledger = Box::new(ledger.clone());
            m.bus = Box::new(bus.clone());
            m
        };
        let provider = mock(0);
        let w = World {
            store: db.store(),
            db,
            gateway: Gateway::new(vec![provider.clone() as Arc<dyn Provider>], table()),
            provider,
            m: metering(true),
            unbilled: metering(false),
            ledger,
            bus,
            plain: runtime_with(false),
            gated: runtime_with(true),
        };
        w.register(&guardrail("probe", 1, None, ""));
        w.register(&guardrail("thrifty", 1, Some("0.000000000000000001"), ""));
        w.ledger.deposit(USER_A, amt("1000"));
        w.ledger.deposit(USER_B, amt("1000"));
        Some(w)
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// \`runtime.registerAgent\`: parsed, serialised and upserted with \`enabled\` kept.
    fn register(&self, raw: &Json) {
        let g = parse_guardrail(raw).unwrap();
        register_agents(
            &self.store,
            &[BootAgent {
                agent_id: g.agent_id.clone(),
                version: i32::try_from(g.version).unwrap(),
                guardrail: serialise_guardrail(&g),
                enabled: true,
            }],
        )
        .unwrap();
    }

    fn rt<'a>(&'a self, rt: &'a Runtime, gateway: &'a Gateway, m: &'a Metering) -> Rt<'a> {
        Rt {
            rt,
            pool: self.pool(),
            gateway,
            m,
            now: system_now(),
        }
    }

    /// The suite's \`runtime\`.
    fn x(&self) -> Rt<'_> {
        self.rt(&self.plain, &self.gateway, &self.m)
    }

    fn open_as(&self, user: &str, agent: &str) -> SessionRecord {
        runtime::open_session(&self.x(), user, agent).unwrap()
    }

    fn open(&self) -> SessionRecord {
        self.open_as(USER_A, "probe")
    }

    fn log(&self, session: &str) -> Vec<Action> {
        audit::for_session(self.pool(), session, 500).unwrap()
    }

    fn last(&self, session: &str) -> Action {
        self.log(session).pop().unwrap()
    }

    fn count(&self, sql: &str, session: &str) -> i64 {
        self.db.client().query_one(sql, &[&session]).unwrap().get(0)
    }

    fn usage_rows(&self, session: &str) -> i64 {
        self.count(
            "SELECT count(*)::bigint FROM agents.usage_records WHERE session_id = $1::text::uuid",
            session,
        )
    }

    fn claims(&self, session: &str, request: &str) -> i64 {
        self.db
            .client()
            .query_one(
                "SELECT count(*)::bigint FROM agents.think_claims WHERE session_id = $1::text::uuid AND request_id = $2::text",
                &[&session, &request],
            )
            .unwrap()
            .get(0)
    }

    /// \`(status, count)\` of a person's holds, grouped.
    fn holds_by_status(&self, user: &str) -> Vec<(String, i64)> {
        self.db
            .client()
            .query(
                "SELECT status, count(*)::bigint FROM agents.spend_reservations WHERE user_id = $1::text GROUP BY status ORDER BY status",
                &[&user],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    /// \`(reservation_key, status, held, committed)\` of a person's holds, by key.
    fn holds_of(&self, user: &str) -> Vec<(String, String, Amount, Option<Amount>)> {
        self.db
            .client()
            .query(
                "SELECT reservation_key, status, amount::text, committed_amount::text FROM agents.spend_reservations
                  WHERE user_id = $1::text ORDER BY reservation_key",
                &[&user],
            )
            .unwrap()
            .iter()
            .map(|r| {
                let held: String = r.get(2);
                let committed: Option<String> = r.get(3);
                (r.get(0), r.get(1), amt(&held), committed.as_deref().map(amt))
            })
            .collect()
    }

    fn hold_status(&self, user: &str, key: &str) -> String {
        self.holds_of(user)
            .into_iter()
            .find(|h| h.0 == key)
            .unwrap()
            .1
    }

    /// How many commits of a hold reached the planted fault.
    fn commit_attempts(&self) -> i64 {
        self.db
            .client()
            .query_one("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM agents.test_commit_attempts", &[])
            .unwrap()
            .get(0)
    }

    fn session_spend(&self, session: &str) -> Amount {
        meter::session_spend(&mut self.db.client(), session).unwrap()
    }

    /// \`UserSpendStore.set\`: one cap for the call, the session and the day.
    fn cap(&self, user: &str, cap: &str, key: &str) {
        spend::set(
            self.pool(),
            user,
            &SetInput {
                asset_id: Some(FEE.to_owned()),
                per_call: Some(cap.to_owned()),
                per_session: Some(cap.to_owned()),
                per_period: Some(cap.to_owned()),
                period: Some("day".to_owned()),
                idempotency_key: Some(key.to_owned()),
            },
        )
        .unwrap();
    }

    /// \`store.reserve\`: a hold made outside \`think\`.
    fn reserve(&self, session: &str, key: &str, amount: Amount, now: Instant) {
        holds::reserve(
            self.pool(),
            &ReserveInput {
                user_id: USER_A,
                session_id: session,
                reservation_key: key,
                asset_id: FEE,
                amount,
                now,
                agent_cap: None,
                funds: None,
                overage_grace: None,
                team_run: false,
            },
        )
        .unwrap();
    }

    /// \`flakyCommit\`: the first \`fail_commits\` commits of a hold fail ('commit unavailable'), and with
    /// \`release_fails\` every release does ('release unavailable'). The spend gate is the store's own code, so the
    /// faults are planted where it writes: a trigger on \`spend_reservations\` that counts on a sequence, which a
    /// rolled-back transaction does not undo.
    fn flaky(&self, fail_commits: i32, release_fails: bool) {
        self.db
            .client()
            .batch_execute(&format!(
                "CREATE SEQUENCE agents.test_commit_attempts;
                 CREATE FUNCTION agents.test_spend_faults() RETURNS trigger LANGUAGE plpgsql AS $f$
                 BEGIN
                   IF NEW.status = 'committed' AND OLD.status = 'held' THEN
                     IF nextval('agents.test_commit_attempts') <= {fail_commits} THEN
                       RAISE EXCEPTION 'commit unavailable';
                     END IF;
                   ELSIF NEW.status = 'released' AND OLD.status = 'held' AND {release_fails} THEN
                     RAISE EXCEPTION 'release unavailable';
                   END IF;
                   RETURN NEW;
                 END $f$;
                 CREATE TRIGGER test_spend_faults BEFORE UPDATE ON agents.spend_reservations
                   FOR EACH ROW EXECUTE FUNCTION agents.test_spend_faults();"
            ))
            .unwrap();
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

fn think_input<'a>(
    session: &'a str,
    request: &'a str,
    task: &'a str,
    msgs: &'a [ChatMessage],
) -> ThinkInput<'a> {
    ThinkInput {
        session_id: session,
        request_id: request,
        task,
        system: None,
        messages: msgs,
        max_output_tokens: None,
        team_run: false,
    }
}

fn think(x: &Rt<'_>, session: &str, request: &str, task: &str) -> Result<ThinkResult, RunError> {
    let msgs = messages(STAKE);
    runtime::think(x, &think_input(session, request, task, &msgs))
}

fn think_max(
    x: &Rt<'_>,
    session: &str,
    request: &str,
    task: &str,
    max: i64,
) -> Result<ThinkResult, RunError> {
    let msgs = messages(STAKE);
    let mut input = think_input(session, request, task, &msgs);
    input.max_output_tokens = Some(max);
    runtime::think(x, &input)
}

/// \`rejects.toMatchObject({ refusal: ... })\`: a \`RefusedError\`.
fn refusal(r: Result<ThinkResult, RunError>) -> Refusal {
    match r {
        Err(RunError::Refused { refusal, .. }) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// \`rejects.toMatchObject({ code })\` on an \`AgentError\` that is not a guardrail refusal.
fn agent_code(r: Result<ThinkResult, RunError>) -> &'static str {
    match r {
        Err(RunError::Agent(d)) => d.error.code,
        other => panic!("expected an AgentError, got {other:?}"),
    }
}

fn kind_status(a: &Action) -> String {
    format!("{}:{}", a.kind, a.status)
}

fn s(v: &str) -> Json {
    Json::str(v)
}

// ── per-task model routing (§8.2) ───────────────────────────────────────────

/// runtime.test.ts, "per-task model routing (§8.2)": "serves each task on the model its route configures".
#[test]
fn serves_each_task_on_the_model_its_route_configures() {
    let w = world_or_skip!();
    let session = w.open();
    let plan = think(&w.x(), &session.id, "r-plan", "plan").unwrap();
    let quick = think(&w.x(), &session.id, "r-quick", "quick").unwrap();
    assert_eq!(plan.route.model, "reasoning-lg");
    assert_eq!(quick.route.model, "fast-sm");
    // The provider echoes the model it was asked for: the routing decision reached the adapter.
    assert!(plan.text.contains("reasoning-lg"));
    assert!(quick.text.contains("fast-sm"));
    // The audit row records the alias, not a vendor's model id.
    assert_eq!(plan.action.model.as_deref(), Some("reasoning-lg"));
}

/// runtime.test.ts, "per-task model routing (§8.2)": "applies the route’s output ceiling, and lets a caller ask for
/// less but not more".
#[test]
fn applies_the_route_output_ceiling_and_lets_a_caller_ask_for_less_but_not_more() {
    let w = world_or_skip!();
    let session = w.open();
    let capped = think_max(&w.x(), &session.id, "r-capped", "quick", 4096).unwrap();
    assert!(capped.usage.output_tokens <= 64);
    assert_eq!(capped.usage, expected_usage("quick", None).1);
    let tighter = think_max(&w.x(), &session.id, "r-tight", "quick", 8).unwrap();
    assert!(tighter.usage.output_tokens <= 8);
}

/// runtime.test.ts, "per-task model routing (§8.2)": "is data, not code — swapping the table re-routes without touching
/// a caller".
#[test]
fn is_data_not_code_swapping_the_table_reroutes_without_touching_a_caller() {
    let w = world_or_skip!();
    let session = w.open();
    let before = think(&w.x(), &session.id, "r-1", "plan").unwrap();
    assert_eq!(before.route.model, "reasoning-lg");
    let swapped = Gateway::new(
        vec![w.provider.clone() as Arc<dyn Provider>],
        parse_routing_table(
            r#"{"routes":[{"task":"plan","providerId":"primary","model":"fast-sm","maxOutputTokens":32,"price":{"inputPerMillion":"0.25","outputPerMillion":"1.25"}}]}"#,
        )
        .unwrap(),
    );
    let after = think(&w.rt(&w.plain, &swapped, &w.m), &session.id, "r-2", "plan").unwrap();
    assert_eq!(after.route.model, "fast-sm");
    assert!(after.text.contains("fast-sm"));
}

/// runtime.test.ts, "per-task model routing (§8.2)": "refuses an unrouted task, and logs the attempt rather than
/// swallowing it".
#[test]
fn refuses_an_unrouted_task_and_logs_the_attempt() {
    let w = world_or_skip!();
    let session = w.open();
    assert_eq!(
        agent_code(think(&w.x(), &session.id, "r-nope", "does.not.exist")),
        "agents.route_not_found"
    );
    let last = w.last(&session.id);
    assert_eq!(kind_status(&last), "completion:failed");
    assert_eq!(last.task.as_deref(), Some("does.not.exist"));
}

/// runtime.test.ts, "per-task model routing (§8.2)": "refuses a route whose provider is not registered".
#[test]
fn refuses_a_route_whose_provider_is_not_registered() {
    let w = world_or_skip!();
    let session = w.open();
    assert_eq!(
        agent_code(think(&w.x(), &session.id, "r-orphan", "orphan")),
        "agents.route_not_found"
    );
}

// ── guardrails — refused before execution, and logged as refused ────────────

/// runtime.test.ts, "guardrails": "refuses an engine call the agent is not permitted to make, and bills nothing".
#[test]
fn refuses_an_engine_call_the_agent_is_not_permitted_to_make_and_bills_nothing() {
    let w = world_or_skip!();
    let session = w.open();
    assert!(matches!(
        think(&w.x(), &session.id, "r-vec", "vectors"),
        Err(RunError::Refused { .. })
    ));
    assert_eq!(w.provider.call_count(), 0);
    assert_eq!(w.ledger.available(USER_A), "1000");
    let last = w.last(&session.id);
    assert_eq!(kind_status(&last), "completion:refused");
    assert_eq!(last.task.as_deref(), Some("vectors"));
}

/// runtime.test.ts, "guardrails": "refuses a call that could cross the session spend ceiling, before spending anything".
#[test]
fn refuses_a_call_that_could_cross_the_session_spend_ceiling_before_spending_anything() {
    let w = world_or_skip!();
    let session = w.open_as(USER_A, "thrifty");
    let r = refusal(think(&w.x(), &session.id, "r-spend", "plan"));
    assert_eq!(r.code, "agents.spend_limit");
    assert_eq!(w.provider.call_count(), 0);
    assert_eq!(w.ledger.available(USER_A), "1000");
    assert_eq!(w.ledger.totals(), "0");
}

/// runtime.test.ts, "guardrails": "a charge that lands exactly on the ceiling commits its real cost".
#[test]
fn a_charge_that_lands_exactly_on_the_ceiling_commits_its_real_cost() {
    let w = world_or_skip!();
    let (r, usage) = expected_usage("quick", Some(1));
    let expected = cost_of(&r, usage);
    assert!(expected > 0);
    w.register(&guardrail(
        "exact-cap",
        1,
        Some(&format_amount(expected)),
        "",
    ));
    let session = w.open_as(USER_A, "exact-cap");
    assert_eq!(
        session.guardrail.limits.max_spend_per_session,
        Some(expected)
    );
    let result = think_max(&w.x(), &session.id, "exact-one", "quick", 1).unwrap();
    assert_eq!(result.cost, expected);
    assert!(result.metered);
    assert_eq!(w.session_spend(&session.id), expected);
}

/// runtime.test.ts, "guardrails": "overlapping thinks that each fit alone do not both commit past the ceiling".
#[test]
fn overlapping_thinks_that_each_fit_alone_do_not_both_commit_past_the_ceiling() {
    let w = world_or_skip!();
    let (r, usage) = expected_usage("quick", Some(1));
    let expected = cost_of(&r, usage);
    assert!(expected > 0);
    w.register(&guardrail(
        "pair-cap",
        1,
        Some(&format_amount(expected)),
        "",
    ));
    let session = w.open_as(USER_A, "pair-cap");
    let gate = Gated::new(&w.provider, Mode::Both);
    let gated = Gateway::new(vec![gate.clone() as Arc<dyn Provider>], table());
    let local = w.rt(&w.plain, &gated, &w.m);
    let (left, right) = std::thread::scope(|sc| {
        let left = sc.spawn(|| think_max(&local, &session.id, "pair-a", "quick", 1));
        let right = sc.spawn(|| think_max(&local, &session.id, "pair-b", "quick", 1));
        gate.wait_ready();
        gate.release();
        (left.join().unwrap(), right.join().unwrap())
    });
    let (won, lost): (Vec<_>, Vec<_>) = [left, right].into_iter().partition(Result::is_ok);
    assert_eq!(won.len(), 1);
    assert_eq!(lost.len(), 1);
    assert_eq!(won.into_iter().next().unwrap().unwrap().cost, expected);
    assert_eq!(
        refusal(lost.into_iter().next().unwrap()).code,
        "agents.spend_limit"
    );
    assert_eq!(w.usage_rows(&session.id), 1);
    assert_eq!(w.session_spend(&session.id), expected);
    let stored = runtime::session(w.pool(), &session.id).unwrap().unwrap();
    assert_eq!(
        stored.guardrail.limits.max_spend_per_session,
        Some(expected)
    );
}

/// runtime.test.ts, "guardrails": "a null spend ceiling stays null while overlapping thinks commit their real costs".
#[test]
fn a_null_spend_ceiling_stays_null_while_overlapping_thinks_commit_their_real_costs() {
    let w = world_or_skip!();
    let session = w.open();
    assert_eq!(session.guardrail.limits.max_spend_per_session, None);
    let gate = Gated::new(&w.provider, Mode::Both);
    let gated = Gateway::new(vec![gate.clone() as Arc<dyn Provider>], table());
    let local = w.rt(&w.plain, &gated, &w.m);
    let (r, usage) = expected_usage("plan", None);
    let expected = cost_of(&r, usage);
    let (a, b) = std::thread::scope(|sc| {
        let left = sc.spawn(|| think(&local, &session.id, "null-a", "plan"));
        let right = sc.spawn(|| think(&local, &session.id, "null-b", "plan"));
        gate.wait_ready();
        gate.release();
        (
            left.join().unwrap().unwrap(),
            right.join().unwrap().unwrap(),
        )
    });
    assert_eq!(a.cost, expected);
    assert_eq!(b.cost, expected);
    let stored = runtime::session(w.pool(), &session.id).unwrap().unwrap();
    assert_eq!(stored.guardrail.limits.max_spend_per_session, None);
    assert_eq!(w.usage_rows(&session.id), 2);
}

/// runtime.test.ts, "guardrails": "refuses a run when the user has set no spend limit, before the provider is called".
#[test]
fn refuses_a_run_when_the_user_has_set_no_spend_limit_before_the_provider_is_called() {
    let w = world_or_skip!();
    let session = w.open();
    let before = w.provider.call_count();
    let r = refusal(think(
        &w.rt(&w.gated, &w.gateway, &w.m),
        &session.id,
        "no-user-cap",
        "plan",
    ));
    assert_eq!(r.code, "agents.spend_limit");
    assert_eq!(r.user_message_key, "agents.refused.spend_limit_unset");
    assert_eq!(w.provider.call_count(), before);
    assert_eq!(w.ledger.totals(), "0");
}

/// runtime.test.ts, "guardrails": "holds the route worst case, commits the real cost once, and refuses a second call
/// that would pass the cap".
#[test]
fn holds_the_route_worst_case_commits_the_real_cost_once_and_refuses_a_second_call_past_the_cap() {
    let w = world_or_skip!();
    let worst = worst_of("quick", Some(1));
    w.cap(USER_A, &format_amount(worst), "cap-once");
    let session = w.open();
    let x = w.rt(&w.gated, &w.gateway, &w.m);
    let before = w.provider.call_count();
    let result = think_max(&x, &session.id, "cap-a", "quick", 1).unwrap();
    assert!(result.cost <= worst);
    assert_eq!(w.holds_by_status(USER_A), [("committed".to_owned(), 1)]);
    assert_eq!(
        refusal(think_max(&x, &session.id, "cap-b", "quick", 1)).code,
        "agents.spend_limit"
    );
    assert_eq!(w.provider.call_count(), before + 1);
}

/// The over-cap gateway of the next cases (\`overCapGateway\`) and the plan route's worst case.
fn over_cap(w: &World) -> (Gateway, Amount, String) {
    let worst = worst_of("plan", None);
    let gateway = Gateway::new(
        vec![Arc::new(Inflating(w.provider.clone())) as Arc<dyn Provider>],
        table(),
    );
    (gateway, worst, format_amount(worst))
}

/// runtime.test.ts, "guardrails": "an over-cap completion commits the hold, releases the claim, then refuses the text".
#[test]
fn an_over_cap_completion_commits_the_hold_releases_the_claim_then_refuses_the_text() {
    let w = world_or_skip!();
    let (gateway, worst, cap) = over_cap(&w);
    let (r, usage) = expected_usage("plan", None);
    let inflated = cost_of(
        &r,
        TokenUsage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens + 1_000_000,
        },
    );
    assert!(inflated > worst);
    w.cap(USER_A, &cap, "over-cap");
    let session = w.open();
    let x = w.rt(&w.gated, &gateway, &w.m);
    let before = w.provider.call_count();
    let refused = refusal(think(&x, &session.id, "over-cap", "plan"));
    assert_eq!(refused.code, "agents.spend_limit");
    assert_eq!(refused.user_message_key, "agents.refused.spend_cap");
    assert_eq!(
        refused.user_message_params,
        vec![
            ("limit".to_owned(), s(&cap)),
            ("asset".to_owned(), s(FEE)),
            ("scope".to_owned(), s("call")),
        ]
    );
    assert_eq!(w.provider.call_count(), before + 1);
    let rows = w.holds_of(USER_A);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "committed");
    assert_eq!(rows[0].2, worst);
    assert_eq!(rows[0].3, Some(worst));
    assert_ne!(rows[0].3, Some(inflated));
    assert_eq!(w.claims(&session.id, "over-cap"), 0);
    assert_eq!(w.usage_rows(&session.id), 0);
    let log = audit::for_session(w.pool(), &session.id, 50).unwrap();
    assert!(
        !log.iter()
            .any(|a| a.status == "executed" && a.output_digest.is_some())
    );
    assert!(
        log.iter()
            .any(|a| a.kind == "completion" && a.status == "refused")
    );
}

/// runtime.test.ts, "guardrails": "retries an over-cap commit without calling the provider again".
#[test]
fn retries_an_over_cap_commit_without_calling_the_provider_again() {
    let w = world_or_skip!();
    let (gateway, worst, cap) = over_cap(&w);
    w.cap(USER_A, &cap, "over-cap-retry");
    let session = w.open();
    w.flaky(1, false);
    let before = w.provider.call_count();
    let refused = refusal(think(
        &w.rt(&w.gated, &gateway, &w.m),
        &session.id,
        "over-cap-retry",
        "plan",
    ));
    assert_eq!(refused.code, "agents.spend_limit");
    assert_eq!(refused.user_message_key, "agents.refused.spend_cap");
    assert_eq!(w.provider.call_count(), before + 1);
    let row = w
        .holds_of(USER_A)
        .into_iter()
        .find(|h| h.0 == "over-cap-retry")
        .unwrap();
    assert_eq!(row.1, "committed");
    assert_eq!(row.3, Some(worst));
    assert_eq!(
        w.commit_attempts(),
        2,
        "one failed commit, then one retried"
    );
    assert_eq!(w.claims(&session.id, "over-cap-retry"), 0);
}

/// runtime.test.ts, "guardrails": "releases the claim and the hold together when an over-cap commit still fails".
#[test]
fn releases_the_claim_and_the_hold_together_when_an_over_cap_commit_still_fails() {
    let w = world_or_skip!();
    let (gateway, _, cap) = over_cap(&w);
    w.cap(USER_A, &cap, "over-cap-give-up");
    let session = w.open();
    w.flaky(2, true);
    let before = w.provider.call_count();
    match think(
        &w.rt(&w.gated, &gateway, &w.m),
        &session.id,
        "over-cap-give-up",
        "plan",
    ) {
        Err(RunError::Store(e)) => assert!(e.message.contains("release unavailable"), "{e}"),
        other => panic!("expected 'release unavailable', got {other:?}"),
    }
    assert_eq!(w.provider.call_count(), before + 1);
    assert_eq!(w.commit_attempts(), 2);
    assert_eq!(w.hold_status(USER_A, "over-cap-give-up"), "held");
    assert_eq!(w.claims(&session.id, "over-cap-give-up"), 0);
}

/// runtime.test.ts, "guardrails": "releases the hold when an over-cap commit cannot be retried".
#[test]
fn releases_the_hold_when_an_over_cap_commit_cannot_be_retried() {
    let w = world_or_skip!();
    let (gateway, _, cap) = over_cap(&w);
    w.cap(USER_A, &cap, "over-cap-release");
    let session = w.open();
    w.flaky(2, false);
    let before = w.provider.call_count();
    match think(
        &w.rt(&w.gated, &gateway, &w.m),
        &session.id,
        "over-cap-release",
        "plan",
    ) {
        Err(RunError::Store(e)) => assert!(e.message.contains("commit unavailable"), "{e}"),
        other => panic!("expected 'commit unavailable', got {other:?}"),
    }
    assert_eq!(w.provider.call_count(), before + 1);
    assert_eq!(w.commit_attempts(), 2);
    assert_eq!(w.hold_status(USER_A, "over-cap-release"), "released");
    assert_eq!(w.claims(&session.id, "over-cap-release"), 0);
}

/// runtime.test.ts, "guardrails": "an unmetered run commits the real cost so the user cap accumulates".
#[test]
fn an_unmetered_run_commits_the_real_cost_so_the_user_cap_accumulates() {
    let w = world_or_skip!();
    let worst = worst_of("plan", None);
    let (r, usage) = expected_usage("plan", None);
    let cost = cost_of(&r, usage);
    assert!(cost > 0);
    assert!(cost < worst);
    w.cap(USER_A, &format_amount(worst), "unmetered-accum");
    let session = w.open();
    let x = w.rt(&w.gated, &w.gateway, &w.unbilled);
    let result = think(&x, &session.id, "unmetered-cost", "plan").unwrap();
    assert!(!result.metered);
    assert_eq!(result.cost, 0);
    let rows = w.holds_of(USER_A);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "committed");
    assert_eq!(rows[0].3, Some(cost));
    assert_ne!(rows[0].3, Some(0));
    let log = audit::for_session(w.pool(), &session.id, 50).unwrap();
    let executed = log
        .iter()
        .find(|a| a.kind == "completion" && a.status == "executed")
        .unwrap();
    assert_eq!(executed.cost, 0);
    assert_eq!(w.usage_rows(&session.id), 0);
    let before = w.provider.call_count();
    assert_eq!(
        refusal(think(&x, &session.id, "unmetered-cost-2", "plan")).code,
        "agents.spend_limit"
    );
    assert_eq!(w.provider.call_count(), before);
}

/// runtime.test.ts, "guardrails": "metering-off does not call the provider again on a committed hold that no longer
/// fits".
#[test]
fn metering_off_does_not_call_the_provider_again_on_a_committed_hold_that_no_longer_fits() {
    let w = world_or_skip!();
    let worst = worst_of("plan", None);
    w.cap(USER_A, &format_amount(worst), "off-replay-hold");
    let session = w.open();
    let x = w.rt(&w.gated, &w.gateway, &w.unbilled);
    let before = w.provider.call_count();
    let first = think(&x, &session.id, "off-committed", "plan").unwrap();
    assert!(!first.metered);
    assert_eq!(first.cost, 0);
    assert_eq!(
        refusal(think(&x, &session.id, "off-committed", "plan")).code,
        "agents.spend_limit"
    );
    assert_eq!(w.provider.call_count(), before + 1);
    let (r, usage) = expected_usage("plan", None);
    let cost = cost_of(&r, usage);
    let rows = w.holds_of(USER_A);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "committed");
    assert_eq!(rows[0].3, Some(cost));
    assert_eq!(w.usage_rows(&session.id), 0);
    assert_eq!(w.ledger.available(USER_A), "1000");
    assert_eq!(w.ledger.house(), "0");
}

/// runtime.test.ts, "guardrails": "metering-off repeats a request id only after a new hold that fits the committed
/// total".
#[test]
fn metering_off_repeats_a_request_id_only_after_a_new_hold_that_fits_the_committed_total() {
    let w = world_or_skip!();
    w.cap(USER_A, "1000", "off-replay-fits");
    let session = w.open();
    let x = w.rt(&w.gated, &w.gateway, &w.unbilled);
    let before = w.provider.call_count();
    let first = think(&x, &session.id, "off-fits", "plan").unwrap();
    let second = think(&x, &session.id, "off-fits", "plan").unwrap();
    assert!(!first.metered);
    assert!(!second.metered);
    assert_eq!(first.cost, 0);
    assert_eq!(second.cost, 0);
    assert_eq!(w.provider.call_count(), before + 2);
    let (r, usage) = expected_usage("plan", None);
    let cost = cost_of(&r, usage);
    let rows = w.holds_of(USER_A);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter().map(|h| h.0.as_str()).collect::<Vec<_>>(),
        ["off-fits", "off-fits:1"]
    );
    assert!(rows.iter().all(|h| h.1 == "committed"));
    assert_eq!(rows[0].3.unwrap() + rows[1].3.unwrap(), cost + cost);
    assert_eq!(w.usage_rows(&session.id), 0);
}

/// runtime.test.ts, "guardrails": "an in-flight hold does not authorize another provider call when a new one does not
/// fit".
#[test]
fn an_in_flight_hold_does_not_authorize_another_provider_call() {
    let w = world_or_skip!();
    let worst = worst_of("plan", None);
    w.cap(USER_A, &format_amount(worst), "off-inflight");
    let session = w.open();
    w.reserve(&session.id, "off-inflight", worst, system_now());
    let x = w.rt(&w.gated, &w.gateway, &w.unbilled);
    let before = w.provider.call_count();
    assert_eq!(
        agent_code(think(&x, &session.id, "off-inflight", "plan")),
        "agents.spend_reservation_conflict"
    );
    assert_eq!(w.provider.call_count(), before);
    assert_eq!(w.holds_by_status(USER_A), [("held".to_owned(), 1)]);
}

/// runtime.test.ts, "guardrails": "concurrent metering-off thinks with one request id call the provider once".
#[test]
fn concurrent_metering_off_thinks_with_one_request_id_call_the_provider_once() {
    let w = world_or_skip!();
    w.cap(USER_A, "1000", "off-concurrent");
    let session = w.open();
    let gate = Gated::new(&w.provider, Mode::First);
    let gated = Gateway::new(vec![gate.clone() as Arc<dyn Provider>], table());
    let x = w.rt(&w.gated, &gated, &w.unbilled);
    let before = w.provider.call_count();
    let done = std::thread::scope(|sc| {
        let first = sc.spawn(|| think(&x, &session.id, "off-same", "plan"));
        gate.wait_ready();
        assert_eq!(
            agent_code(think(&x, &session.id, "off-same", "plan")),
            "agents.spend_reservation_conflict"
        );
        assert_eq!(gate.entered(), 1);
        assert_eq!(w.provider.call_count(), before);
        gate.release();
        first.join().unwrap().unwrap()
    });
    assert!(!done.metered);
    assert_eq!(w.provider.call_count(), before + 1);
    assert_eq!(w.holds_by_status(USER_A), [("committed".to_owned(), 1)]);
}

/// runtime.test.ts, "guardrails": "reconcileSpendHolds releases an old hold only when an age is set".
#[test]
fn reconcile_spend_holds_releases_an_old_hold_only_when_an_age_is_set() {
    let w = world_or_skip!();
    w.cap(USER_A, "1000", "reconcile-age");
    let session = w.open();
    w.reserve(
        &session.id,
        "stale-runtime",
        amt("1"),
        js_date("2020-01-01T00:00:00Z").unwrap(),
    );
    match holds::release_stale_holds(w.pool(), Some("   "), system_now()) {
        Err(holds::HoldError::Denied(d)) => {
            assert_eq!(d.error.code, "agents.spend_hold_max_age_unset");
        }
        other => panic!("expected the age refused, got {other:?}"),
    }
    assert_eq!(w.hold_status(USER_A, "stale-runtime"), "held");
    let released = holds::release_stale_holds(w.pool(), Some("1"), system_now()).unwrap();
    assert_eq!(released, 1);
    assert_eq!(w.hold_status(USER_A, "stale-runtime"), "released");
}

/// runtime.test.ts, "guardrails": "binds the guardrail at session open — widening it later does not reach a running
/// session". The TypeScript observes the binding through \`act\` (a tool slice's); here it is read from the sessions
/// themselves: the running one keeps version 1 without the new tool, a new one binds version 2 with it.
#[test]
fn binds_the_guardrail_at_session_open_widening_it_later_does_not_reach_a_running_session() {
    let w = world_or_skip!();
    let session = w.open();
    w.register(&guardrail("probe", 2, None, CLOSE_TOOL));
    let running = runtime::session(w.pool(), &session.id).unwrap().unwrap();
    assert_eq!(running.guardrail_version, 1);
    assert!(
        !running
            .guardrail
            .tools
            .iter()
            .any(|t| t.name == "trade.close")
    );
    let next = w.open();
    assert_eq!(next.guardrail_version, 2);
    assert!(next.guardrail.tools.iter().any(|t| t.name == "trade.close"));
}

/// runtime.test.ts, "guardrails": "operator kill (enabled=false) survives boot re-register of the guardrail".
#[test]
fn operator_kill_survives_boot_re_register_of_the_guardrail() {
    let w = world_or_skip!();
    w.db.client()
        .execute(
            "UPDATE agents.agent_definitions SET enabled = false WHERE agent_id = 'probe'",
            &[],
        )
        .unwrap();
    let refused = |w: &World| match runtime::open_session(&w.x(), USER_A, "probe") {
        Err(RunError::Agent(d)) => d.error.code,
        other => panic!("expected the agent refused, got {other:?}"),
    };
    assert_eq!(refused(&w), "agents.agent_not_found");
    w.register(&guardrail("probe", 9, None, CLOSE_TOOL));
    let (g, enabled) = runtime::agent_definition(w.pool(), "probe")
        .unwrap()
        .unwrap();
    assert!(!enabled);
    assert_eq!(g.version, 9);
    assert_eq!(refused(&w), "agents.agent_not_found");
}

/// runtime.test.ts, "guardrails": "refuses everything on a closed session".
#[test]
fn refuses_everything_on_a_closed_session() {
    let w = world_or_skip!();
    let session = w.open();
    runtime::close_session(&w.x(), &session.id).unwrap();
    assert_eq!(
        agent_code(think(&w.x(), &session.id, "r-late", "plan")),
        "agents.session_closed"
    );
}

// ── agent_actions — the Agentic Law (§8.2) ──────────────────────────────────

/// runtime.test.ts, "agent_actions": "records every action, including the ones that were refused". The TypeScript's
/// executed and refused rows are tool calls made with \`act\` (a tool slice's); here the same two outcomes are made by
/// this slice's own call, a completion executed and one the guardrail refused.
#[test]
fn records_every_action_including_the_ones_that_were_refused() {
    let w = world_or_skip!();
    let session = w.open();
    think(&w.x(), &session.id, "r-a", "plan").unwrap();
    think(&w.x(), &session.id, "r-q", "quick").unwrap();
    let _ = think(&w.x(), &session.id, "r-vec", "vectors").unwrap_err();
    runtime::close_session(&w.x(), &session.id).unwrap();
    let log = w.log(&session.id);
    assert_eq!(
        log.iter().map(kind_status).collect::<Vec<_>>(),
        [
            "session_open:executed",
            "completion:executed",
            "completion:executed",
            "completion:refused",
            "session_close:executed",
        ]
    );
    // Dense sequence: a gap would mean an action went unrecorded.
    assert_eq!(
        log.iter().map(|a| a.sequence).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
}

fn append_only(w: &World, sql: &str, session: &str) {
    let e = w.db.client().execute(sql, &[&session]).unwrap_err();
    let text = e
        .as_db_error()
        .map_or_else(|| e.to_string(), |d| d.message().to_owned());
    assert!(text.contains("append-only"), "{text}");
}

/// runtime.test.ts, "agent_actions": "is append-only — an UPDATE is rejected by the database". The row is a completion
/// here rather than the TypeScript's \`act\` tool call: the trigger guards every row alike.
#[test]
fn is_append_only_an_update_is_rejected_by_the_database() {
    let w = world_or_skip!();
    let session = w.open();
    think(&w.x(), &session.id, "r-a", "plan").unwrap();
    append_only(
        &w,
        "UPDATE agents.agent_actions SET status = 'executed' WHERE session_id = $1::text::uuid",
        &session.id,
    );
}

/// runtime.test.ts, "agent_actions": "is append-only — a DELETE is rejected by the database". The refused row is a
/// completion the guardrail refused, rather than the TypeScript's refused \`act\`.
#[test]
fn is_append_only_a_delete_is_rejected_by_the_database() {
    let w = world_or_skip!();
    let session = w.open();
    let _ = think(&w.x(), &session.id, "r-vec", "vectors").unwrap_err();
    // The row a bad actor would most want gone.
    append_only(
        &w,
        "DELETE FROM agents.agent_actions WHERE session_id = $1::text::uuid AND status = 'refused'",
        &session.id,
    );
    assert!(w.log(&session.id).iter().any(|a| a.status == "refused"));
}

/// runtime.test.ts, "agent_actions": "cannot be edited even to correct it — the correction is another row".
#[test]
fn cannot_be_edited_even_to_correct_it() {
    let w = world_or_skip!();
    let session = w.open();
    think(&w.x(), &session.id, "r-a", "plan").unwrap();
    append_only(
        &w,
        "UPDATE agents.agent_actions SET cost = 0 WHERE session_id = $1::text::uuid",
        &session.id,
    );
}

/// runtime.test.ts, "agent_actions": "chains each session’s actions, so a rewrite around the service is detectable".
/// The third row is a second completion rather than the TypeScript's \`act\` tool call.
#[test]
fn chains_each_sessions_actions_so_a_rewrite_around_the_service_is_detectable() {
    let w = world_or_skip!();
    let session = w.open();
    think(&w.x(), &session.id, "r-a", "plan").unwrap();
    think(&w.x(), &session.id, "r-b", "quick").unwrap();
    assert_eq!(
        audit::verify_chain(w.pool(), &session.id).unwrap(),
        audit::Chain::Ok
    );
    let log = w.log(&session.id);
    assert_eq!(log[0].prev_hash, None);
    assert_eq!(log[1].prev_hash.as_deref(), Some(log[0].hash.as_str()));
    assert_eq!(log[2].prev_hash.as_deref(), Some(log[1].hash.as_str()));
}

/// runtime.test.ts, "agent_actions": "detects a row whose contents no longer match its hash".
#[test]
fn detects_a_row_whose_contents_no_longer_match_its_hash() {
    let w = world_or_skip!();
    let session = w.open();
    let row = w.log(&session.id).remove(0);
    let params: Vec<(String, Json)> = match &row.user_message_params {
        Json::Object(f) => f.clone(),
        _ => Vec::new(),
    };
    let hash = |status: &str| {
        audit::hash_action(
            &audit::Hashable {
                session_id: &row.session_id,
                user_id: &row.user_id,
                agent_id: &row.agent_id,
                sequence: row.sequence,
                kind: &row.kind,
                status,
                tool: row.tool.as_deref(),
                task: row.task.as_deref(),
                provider_id: row.provider_id.as_deref(),
                model: row.model.as_deref(),
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                cost: row.cost,
                refusal_code: row.refusal_code.as_deref(),
                user_message_key: &row.user_message_key,
                params: &params,
                input_digest: row.input_digest.as_deref(),
                output_digest: row.output_digest.as_deref(),
                occurred_at: row.occurred_at,
            },
            row.prev_hash.as_deref(),
        )
    };
    assert_eq!(hash(&row.status), row.hash);
    assert_ne!(hash("refused"), row.hash);
}

fn is_digest(d: Option<&str>) -> bool {
    d.is_some_and(|d| {
        d.len() == 64
            && d.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// runtime.test.ts, "agent_actions": "stores digests of the prompt and the answer, never their text".
#[test]
fn stores_digests_of_the_prompt_and_the_answer_never_their_text() {
    let w = world_or_skip!();
    let session = w.open();
    let msgs = messages("my recovery phrase is aardvark banana cinnamon");
    let result =
        runtime::think(&w.x(), &think_input(&session.id, "r-secret", "plan", &msgs)).unwrap();
    let raw: String =
        w.db.client()
            .query_one(
                "SELECT row_to_json(a)::text FROM agents.agent_actions a WHERE id = $1::text::uuid",
                &[&result.action.id],
            )
            .unwrap()
            .get(0);
    assert!(!raw.contains("aardvark"));
    assert!(is_digest(result.action.input_digest.as_deref()));
    assert!(is_digest(result.action.output_digest.as_deref()));
}

/// runtime.test.ts, "agent_actions": "gives a user their own log, and only their own".
#[test]
fn gives_a_user_their_own_log_and_only_their_own() {
    let w = world_or_skip!();
    let a = w.open_as(USER_A, "probe");
    let b = w.open_as(USER_B, "probe");
    think(&w.x(), &a.id, "r-a", "plan").unwrap();
    think(&w.x(), &b.id, "r-b", "plan").unwrap();
    let log = audit::for_user(w.pool(), USER_A, 100, None).unwrap();
    assert!(!log.is_empty());
    assert!(log.iter().all(|e| e.user_id == USER_A));
}

/// runtime.test.ts, "agent_actions": "keys every log line for i18n rather than shipping prose". The refused row is a
/// refused completion rather than the TypeScript's refused \`act\`.
#[test]
fn keys_every_log_line_for_i18n_rather_than_shipping_prose() {
    let w = world_or_skip!();
    let session = w.open();
    think(&w.x(), &session.id, "r-a", "plan").unwrap();
    let _ = think(&w.x(), &session.id, "r-vec", "vectors").unwrap_err();
    let log = w.log(&session.id);
    assert_eq!(log.len(), 3);
    for action in log {
        assert!(
            action.user_message_key.starts_with("agents."),
            "{}",
            action.user_message_key
        );
    }
}

// ── provider failure degrades cleanly ───────────────────────────────────────

/// runtime.test.ts, "provider failure degrades cleanly": "bills nothing when the engine is down, and says so in the
/// log".
#[test]
fn bills_nothing_when_the_engine_is_down_and_says_so_in_the_log() {
    let w = world_or_skip!();
    let session = w.open();
    w.provider.break_with(down());
    assert!(matches!(
        think(&w.x(), &session.id, "r-down", "plan"),
        Err(RunError::Agent(_))
    ));
    assert_eq!(w.ledger.available(USER_A), "1000");
    assert_eq!(w.ledger.house(), "0");
    assert_eq!(w.usage_rows(&session.id), 0);
    let last = w.last(&session.id);
    assert_eq!(kind_status(&last), "completion:failed");
    assert_eq!(last.user_message_key, "agents.error.engine_unavailable");
    assert_eq!(w.ledger.totals(), "0");
}

/// runtime.test.ts, "provider failure degrades cleanly": "bills once when a transient failure is retried under the
/// same request id".
#[test]
fn bills_once_when_a_transient_failure_is_retried_under_the_same_request_id() {
    let w = world_or_skip!();
    let session = w.open();
    let flaky = Gateway::new(vec![mock(1) as Arc<dyn Provider>], table());
    let x = w.rt(&w.plain, &flaky, &w.m);
    assert!(matches!(
        think(&x, &session.id, "same-request", "plan"),
        Err(RunError::Agent(_))
    ));
    let ok = think(&x, &session.id, "same-request", "plan").unwrap();
    let settlement = settle::settle_window(
        &w.m,
        w.pool(),
        &session.id,
        ok.window_id.as_deref().unwrap(),
        system_now(),
    )
    .unwrap();
    assert_eq!(settlement.amount, cost_of(&ok.route, ok.usage));
    assert_eq!(w.ledger.house(), format_amount(settlement.amount));
    assert_eq!(w.ledger.totals(), "0");
}

/// runtime.test.ts, "provider failure degrades cleanly": "does not route to a provider that is already known to be
/// unhealthy".
#[test]
fn does_not_route_to_a_provider_that_is_already_known_to_be_unhealthy() {
    let w = world_or_skip!();
    let session = w.open();
    w.provider.break_with(down());
    assert_eq!(
        agent_code(think(&w.x(), &session.id, "r-x", "plan")),
        "agents.provider_unavailable"
    );
    // Refused on health: the request never left the process.
    assert_eq!(w.provider.call_count(), 0);
}

/// runtime.test.ts, "provider failure degrades cleanly": "recovers without leaving a partial charge behind".
#[test]
fn recovers_without_leaving_a_partial_charge_behind() {
    let w = world_or_skip!();
    let session = w.open();
    w.provider.break_with(down());
    let _ = think(&w.x(), &session.id, "r-1", "plan");
    w.provider.repair();
    let ok = think(&w.x(), &session.id, "r-2", "plan").unwrap();
    let settlement = settle::settle_window(
        &w.m,
        w.pool(),
        &session.id,
        ok.window_id.as_deref().unwrap(),
        system_now(),
    )
    .unwrap();
    assert_eq!(settlement.amount, cost_of(&ok.route, ok.usage));
    assert_eq!(w.ledger.totals(), "0");
}

// ── events (§10) ────────────────────────────────────────────────────────────

/// runtime.test.ts, "events (§10)": "publishes a completed action, a rejected action, and a settled window". The
/// rejected action is a completion the guardrail refused rather than the TypeScript's \`act\` on an undeclared tool, so
/// its payload names the refused task where the TypeScript's names the tool.
#[test]
fn publishes_a_completed_action_a_rejected_action_and_a_settled_window() {
    let w = world_or_skip!();
    let session = w.open();
    let call = think(&w.x(), &session.id, "r-a", "plan").unwrap();
    let refused = refusal(think(&w.x(), &session.id, "r-vec", "vectors"));
    let window = call.window_id.clone().unwrap();
    settle::settle_window(&w.m, w.pool(), &session.id, &window, system_now()).unwrap();
    assert!(!w.bus.emitted(ACTION_COMPLETED).is_empty());
    let rejected = &w.bus.emitted(ACTION_REJECTED)[0];
    assert_eq!(rejected.get("refusalCode"), Some(&s(&refused.code)));
    assert_eq!(rejected.get("task"), Some(&s("vectors")));
    assert_eq!(rejected.get("tool"), Some(&Json::Null));
    let settled = &w.bus.emitted(settle::USAGE_SETTLED)[0];
    assert_eq!(settled.get("assetId"), Some(&s(FEE)));
    assert_eq!(settled.get("windowId"), Some(&s(&window)));
}

/// runtime.test.ts, "events (§10)": "carries no prompt, no answer and no vendor model id on the wire".
#[test]
fn carries_no_prompt_no_answer_and_no_vendor_model_id_on_the_wire() {
    let w = world_or_skip!();
    let session = w.open();
    let msgs = messages("aardvark banana cinnamon");
    runtime::think(&w.x(), &think_input(&session.id, "r-a", "plan", &msgs)).unwrap();
    let serialised = w.bus.serialised();
    assert!(!serialised.contains("aardvark"));
    // The routing task travels; the model does not.
    assert!(serialised.contains("plan"));
    assert!(!serialised.contains("reasoning-lg"));
}
