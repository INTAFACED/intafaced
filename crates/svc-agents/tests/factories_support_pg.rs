//! `support.runSession` against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose
//! admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner.
//! Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The cases of `services/svc-agents/src/support-agent/session-run.test.ts` and `run-session-route.test.ts`, ported
//! onto the real runtime through the Rust door: the session is opened, every ask goes through the runtime's `act`
//! (judged by the guardrail stored in `agent_definitions` and written to `agent_actions`), and the session is settled
//! and closed. The TypeScript's fake runtime records which tools reached their executor; here that is the action log
//! (an executed row is a tool that ran, a refused row one the guardrail stopped). The desk is
//! `createFixtureSupportDesk` ported (`FixtureDesk`), with the overrides the TypeScript cases make.
//!
//! Not ported, as the real runtime cannot be made to do what the fake did: the two abort cases (the Rust door has no
//! request abort signal), "reports what the meter settled" (the fake hands back settlements for windows no support run
//! meters: a run never calls the engine, so the real meter has none to settle) and "propagates the original failure
//! even when settlement also fails" (with no window, the real settlement has nothing that can fail).
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
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::db::Store;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::factories::Factories;
use svc_agents::factories::support::{
    Account, AccountRead, Article, Desk, Found, Ticket, TicketRead, guardrail,
};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::metering::ports::Bus;
use svc_agents::runtime::eligibility::parse_tier_laws;
use svc_agents::runtime::guardrails::serialise_guardrail;
use svc_agents::runtime::{RunError, Runtime};

const SECRET: &str = "placeholder-agents-support-pg-edge-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_USER: &str = "99999999-9999-4999-8999-999999999999";
const KB: &str = "support.kb.search";
const MONEY: [&str; 12] = [
    "ledger.post",
    "ledger.hold",
    "pay.refund",
    "pay.capture",
    "bank.transfer",
    "bank.withdraw",
    "bank.loan",
    "trade.order",
    "trade.place",
    "trade.amend",
    "trade.cancel",
    "p2p.release",
];

// ── The desk ────────────────────────────────────────────────────────────────

fn article(key: &str, title: &str, body: &str) -> Article {
    Article {
        article_key: key.to_owned(),
        title_key: title.to_owned(),
        body_key: body.to_owned(),
    }
}

/// `ARTICLE`.
fn withdrawal_hold() -> Article {
    article(
        "support.kb.withdrawal_hold",
        "support.kb.withdrawal_hold.title",
        "support.kb.withdrawal_hold.body",
    )
}

fn account_access() -> Article {
    article(
        "kb-account-access",
        "support.kb.account_access.title",
        "support.kb.account_access.body",
    )
}

/// One call's headers.
type Headers = Vec<(String, String)>;

/// `createFixtureSupportDesk(rows)`, with the overrides the TypeScript cases put on it.
struct FixtureDesk {
    articles: Vec<Article>,
    tickets: Vec<Ticket>,
    accounts: Vec<Account>,
    unread_accounts: bool,
    /// `desk.readAccount = async () => ...`.
    account_override: Option<AccountRead>,
    /// A search that throws.
    search_fails: bool,
    searched: Mutex<Vec<(String, Option<f64>)>>,
    /// The headers each ticket read was sent with.
    ticket_headers: Arc<Mutex<Vec<Headers>>>,
}

/// `testDesk(overrides)`: the article, the person's own ticket and their account.
fn test_desk() -> FixtureDesk {
    FixtureDesk {
        articles: vec![withdrawal_hold()],
        tickets: vec![Ticket {
            ticket_id: "tkt-1".to_owned(),
            owner_user_id: USER.to_owned(),
            status: "open".to_owned(),
            category: "withdrawals".to_owned(),
        }],
        accounts: vec![account(USER, "tier2")],
        unread_accounts: false,
        account_override: None,
        search_fails: false,
        searched: Mutex::new(Vec::new()),
        ticket_headers: Arc::default(),
    }
}

fn account(user: &str, tier: &str) -> Account {
    Account {
        user_id: user.to_owned(),
        status: "active".to_owned(),
        kyc_tier: tier.to_owned(),
    }
}

impl Desk for FixtureDesk {
    fn search_kb(&self, query: &str, limit: Option<f64>) -> Result<Found, RunError> {
        self.searched
            .lock()
            .unwrap()
            .push((query.to_owned(), limit));
        if self.search_fails {
            return Err(RunError::Other("storage exploded".to_owned()));
        }
        let Some(page) = limit.filter(|l| l.is_finite() && l.floor() >= 1.0) else {
            return Ok(Found::LimitUnset);
        };
        let q = query.trim().to_lowercase();
        let hits: Vec<Article> = self
            .articles
            .iter()
            .filter(|a| {
                q.is_empty()
                    || a.article_key.to_lowercase().contains(&q)
                    || a.title_key.to_lowercase().contains(&q)
                    || a.body_key.to_lowercase().contains(&q)
            })
            .take(page.floor().min(500.0) as usize)
            .cloned()
            .collect();
        Ok(Found::Ok(hits))
    }

    fn read_ticket(
        &self,
        ticket_id: &str,
        headers: &[(String, String)],
    ) -> Result<TicketRead, RunError> {
        self.ticket_headers.lock().unwrap().push(headers.to_vec());
        Ok(self
            .tickets
            .iter()
            .find(|t| t.ticket_id == ticket_id)
            .map_or(TicketRead::Missing, |t| TicketRead::Ok(t.clone())))
    }

    fn read_account(&self, user_id: &str) -> Result<AccountRead, RunError> {
        if let Some(o) = &self.account_override {
            return Ok(o.clone());
        }
        if self.unread_accounts {
            return Ok(AccountRead::Unread);
        }
        Ok(self
            .accounts
            .iter()
            .find(|a| a.user_id == user_id)
            .map_or(AccountRead::Unread, |a| AccountRead::Ok(a.clone())))
    }
}

// ── The world ───────────────────────────────────────────────────────────────

/// `law`: the person's plan may use the three desk reads.
fn law_of(tools: &[&str]) -> String {
    Json::obj([(
        "support",
        Json::obj([
            ("published", Json::Bool(true)),
            (
                "matrix",
                Json::obj([(
                    "basic",
                    Json::Array(tools.iter().map(|t| Json::str(*t)).collect()),
                )]),
            ),
        ]),
    )])
    .compact()
}

fn law() -> String {
    law_of(&[KB, "support.ticket.read", "identity.account.read"])
}

struct World {
    db: TestDb,
    store: Store,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let w = World {
            store: db.store(),
            db,
        };
        w.register(&guardrail().unwrap());
        Some(w)
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// The support agent's stored guardrail (the boot's, or a case's own).
    fn register(&self, g: &svc_agents::runtime::guardrails::Guardrail) {
        let stored = serialise_guardrail(g).compact();
        let mut conn = self.pool().get().unwrap();
        conn.client()
            .unwrap()
            .execute(
                "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled)
                 VALUES ('support', $1::int, $2::text::jsonb, true)
                 ON CONFLICT (agent_id) DO UPDATE SET version = EXCLUDED.version, guardrail = EXCLUDED.guardrail",
                &[&i32::try_from(g.version).unwrap(), &stored],
            )
            .unwrap();
    }

    fn door(&self, laws: Option<&str>, desk: Option<FixtureDesk>) -> AgentsDoor {
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("NODE_ENV", "test"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mut runtime = Runtime::unwired();
        runtime.tier_laws = parse_tier_laws(laws).unwrap();
        let mut metering = svc_agents::metering::Metering::unwired("IFC", 60);
        metering.bus = Box::new(Events);
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now: system_now,
            store: self.db.store(),
            gateway: GatewaySlice::unwired("IFC"),
            ready: ReadyInput::unwired(),
            metering,
            runtime,
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            team: svc_agents::team::Team::unwired(),
            own: svc_agents::own::Own::unwired(),
        })
        .unwrap()
        .with_factories(Factories {
            support_desk: desk.map(|d| Box::new(d) as Box<dyn Desk>),
            ..Factories::unwired()
        })
    }

    /// `(kind, status, tool, refusal_code)` of every action, in order.
    fn actions(&self) -> Vec<(String, String, Option<String>, Option<String>)> {
        self.db
            .client()
            .query(
                "SELECT kind::text, status::text, tool, refusal_code FROM agents.agent_actions ORDER BY occurred_at, sequence",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
            .collect()
    }

    fn executed(&self) -> Vec<String> {
        self.tools_with("executed")
    }

    fn refused(&self) -> Vec<String> {
        self.tools_with("refused")
    }

    fn tools_with(&self, status: &str) -> Vec<String> {
        self.actions()
            .into_iter()
            .filter(|a| a.1 == status)
            .filter_map(|a| a.2)
            .collect()
    }

    /// `(status, count)` of the sessions.
    fn sessions(&self) -> Vec<(String, String)> {
        self.db
            .client()
            .query(
                "SELECT id::text, status::text FROM agents.agent_sessions ORDER BY opened_at",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }
}

/// The bus each executed action's completion is published on; these cases read the action log instead.
struct Events;

impl Bus for Events {
    fn publish(&self, _: &str, _: &str, _: &Json) -> Result<(), String> {
        Ok(())
    }
}

/// A `Guardrail` changed in place, as the TypeScript cases change theirs.
trait CloneWith {
    fn clone_with(&self, f: impl FnOnce(&mut Self)) -> Self;
}

impl CloneWith for svc_agents::runtime::guardrails::Guardrail {
    fn clone_with(&self, f: impl FnOnce(&mut Self)) -> Self {
        let mut g = self.clone();
        f(&mut g);
        g
    }
}

fn headers(scopes: &[&str], tier: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        ("userId", Json::str(USER)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str(tier)),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

/// `support.runSession(input)` as the person, read back as `{ data }` or `{ error: { code, message } }`.
fn run_as(door: &AgentsDoor, input: &Json, scopes: &[&str], tier: &str) -> Json {
    let h = headers(scopes, tier);
    let body = input.compact();
    let res = door.handle(&Request {
        method: "POST",
        url: "/trpc/support.runSession",
        headers: &h,
        body: &body,
    });
    let parsed = json::parse(&res.body).unwrap();
    if res.status == 200 {
        return Json::obj([(
            "data",
            parsed
                .get("result")
                .and_then(|r| r.get("data"))
                .cloned()
                .unwrap(),
        )]);
    }
    let e = parsed.get("error").unwrap();
    Json::obj([(
        "error",
        Json::obj([
            (
                "code",
                e.get("data").and_then(|d| d.get("code")).cloned().unwrap(),
            ),
            ("message", e.get("message").cloned().unwrap()),
        ]),
    )])
}

fn run(door: &AgentsDoor, input: &Json) -> Json {
    run_as(door, input, &["agents:read", "agents:execute"], "basic")
}

fn data(answer: &Json) -> &Json {
    answer
        .get("data")
        .unwrap_or_else(|| panic!("an error: {}", answer.compact()))
}

fn s<'a>(v: &'a Json, k: &str) -> &'a str {
    match v.get(k) {
        Some(Json::String(s)) => s,
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

fn arr<'a>(v: &'a Json, k: &str) -> &'a [Json] {
    match v.get(k) {
        Some(Json::Array(a)) => a,
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

fn parse(text: &str) -> Json {
    json::parse(text).unwrap()
}

/// `PUBLISHED_KB`.
const CATALOG: &str = r#"[{"id":"support.kb.withdrawal_hold","titleKey":"support.kb.withdrawal_hold.title","bodyKey":"support.kb.withdrawal_hold.body"}]"#;

/// `kbAsk()`.
const KB_ASK: &str = r#"{"tool":"support.kb.search","articles":[{"articleKey":"support.kb.withdrawal_hold","titleKey":"support.kb.withdrawal_hold.title","bodyKey":"support.kb.withdrawal_hold.body"}],"limit":20}"#;

/// `accountAsk(userId)`.
fn account_ask(user: &str) -> String {
    format!(
        r#"{{"tool":"identity.account.read","account":{{"userId":"{user}","status":"active","kycTier":"tier2"}}}}"#
    )
}

/// `ticketAsk()`.
const TICKET_ASK: &str = r#"{"tool":"support.ticket.read","ticket":{"ticketId":"tkt-1","ownerUserId":"11111111-1111-4111-8111-111111111111","status":"open","category":"withdrawals"}}"#;

/// `baseInput` with these asks: a live plane and the published catalog.
fn input(asks: &[&str]) -> Json {
    parse(&format!(
        r#"{{"plane":"live","kbCatalog":{CATALOG},"asks":[{}]}}"#,
        asks.join(",")
    ))
}

fn unmetered(answer: &Json) {
    assert_eq!(
        answer.get("metering").unwrap(),
        &parse(
            r#"{"sessionId":null,"billedAmount":"0","assetId":"IFC","sessionClosed":false,"settlements":[]}"#
        ),
        "{}",
        answer.compact()
    );
}

// ── support.reply metered session run ──────────────────────────────────────

#[test]
fn answers_through_the_runtime_then_settles_and_closes_the_session() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK, &account_ask(USER)]));
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok", "{}", a.compact());
    assert_eq!(d.get("answered"), Some(&Json::int(2)));
    assert_eq!(d.get("asked"), Some(&Json::int(2)));
    assert_eq!(d.get("complete"), Some(&Json::Bool(true)));
    assert!(arr(d, "unanswered").is_empty());
    assert_eq!(
        arr(d, "citedArticleKeys"),
        &[Json::str("support.kb.withdrawal_hold")]
    );
    assert_eq!(s(&arr(d, "findings")[0], "tool"), KB);
    // One audited tool call per read: the guardrail saw every lookup.
    assert_eq!(w.executed(), vec![KB, "identity.account.read"]);
    let sessions = w.sessions();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].1, "closed");
    let m = d.get("metering").unwrap();
    assert_eq!(s(m, "sessionId"), sessions[0].0);
    assert_eq!(m.get("sessionClosed"), Some(&Json::Bool(true)));
    // The field order the route's output declares.
    let Json::Object(fields) = d else { panic!() };
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "status",
            "userTier",
            "findings",
            "unanswered",
            "citedArticleKeys",
            "asked",
            "answered",
            "complete",
            "metering"
        ]
    );
    assert_eq!(s(d, "userTier"), "basic");
}

#[test]
fn carries_the_account_projection_without_ever_carrying_a_balance() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK, &account_ask(USER)]));
    let found = arr(data(&a), "findings")
        .iter()
        .find(|f| s(f, "tool") == "identity.account.read")
        .cloned()
        .unwrap();
    assert_eq!(
        found,
        parse(&format!(
            r#"{{"status":"ok","tool":"identity.account.read","account":{{"userId":"{USER}","status":"active","kycTier":"tier2"}}}}"#
        ))
    );
}

#[test]
fn bills_zero_for_a_run_that_never_called_the_engine() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK]));
    let m = data(&a).get("metering").unwrap();
    assert_eq!(m.get("billedAmount"), Some(&Json::str("0")));
    assert_eq!(m.get("settlements"), Some(&Json::Array(Vec::new())));
    assert_eq!(m.get("assetId"), Some(&Json::str("IFC")));
}

// ── The guardrail is load-bearing ──────────────────────────────────────────

#[test]
fn does_not_run_a_money_tool_a_caller_supplied_tier_matrix_tried_to_grant() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law_of(&[KB, "pay.refund"])), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK, r#"{"tool":"pay.refund"}"#]));
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok", "{}", a.compact());
    // The refund never reached its executor: no executed row, one refused row.
    assert_eq!(w.executed(), vec![KB]);
    assert_eq!(w.refused(), vec!["pay.refund"]);
    assert_eq!(
        d.get("unanswered").unwrap(),
        &parse(
            r#"[{"tool":"pay.refund","refusedBy":"guardrail","reason":"agents.tool_not_declared","userMessageKey":"agents.refused.tool_not_declared"}]"#
        )
    );
    assert_eq!(d.get("complete"), Some(&Json::Bool(false)));
    assert_eq!(d.get("answered"), Some(&Json::int(1)));
}

#[test]
fn never_reaches_the_executor_for_any_tool_on_the_money_denylist() {
    let Some(w) = World::new() else { return };
    let mut granted = vec![KB];
    granted.extend(MONEY);
    let door = w.door(Some(&law_of(&granted)), Some(test_desk()));
    let money: Vec<String> = MONEY
        .iter()
        .map(|t| format!(r#"{{"tool":"{t}"}}"#))
        .collect();
    let mut asks = vec![KB_ASK];
    asks.extend(money.iter().map(String::as_str));
    let a = run(&door, &input(&asks));
    assert_eq!(s(data(&a), "status"), "ok", "{}", a.compact());
    let declared: Vec<String> = guardrail()
        .unwrap()
        .tools
        .iter()
        .map(|t| t.name.clone())
        .collect();
    assert!(w.executed().iter().all(|t| declared.contains(t)));
    let mut refused = w.refused();
    refused.sort();
    let mut want: Vec<String> = MONEY.iter().map(|t| (*t).to_owned()).collect();
    want.sort();
    assert_eq!(refused, want);
}

#[test]
fn holds_the_approval_gated_comment_tool_rather_than_posting_it_silently() {
    let Some(w) = World::new() else { return };
    let door = w.door(
        Some(&law_of(&[KB, "support.ticket.comment"])),
        Some(test_desk()),
    );
    let a = run(
        &door,
        &input(&[KB_ASK, r#"{"tool":"support.ticket.comment"}"#]),
    );
    assert_eq!(w.executed(), vec![KB]);
    assert_eq!(w.refused(), vec!["support.ticket.comment"]);
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok");
    let u = &arr(d, "unanswered")[0];
    assert_eq!(s(u, "tool"), "support.ticket.comment");
    assert_eq!(s(u, "refusedBy"), "guardrail");
    assert_eq!(s(u, "userMessageKey"), "agents.refused.approval_required");
}

#[test]
fn records_a_guardrail_action_budget_refusal_as_an_unanswered_read() {
    let Some(w) = World::new() else { return };
    w.register(
        &guardrail()
            .unwrap()
            .clone_with(|g| g.limits.max_actions_per_session = 1),
    );
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK, &account_ask(USER), TICKET_ASK]));
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok", "{}", a.compact());
    assert_eq!(d.get("answered"), Some(&Json::int(1)));
    let unanswered = arr(d, "unanswered");
    assert_eq!(unanswered.len(), 2);
    assert!(
        unanswered
            .iter()
            .all(|u| s(u, "refusedBy") == "guardrail" && s(u, "reason") == "agents.action_limit")
    );
    assert_eq!(w.executed(), vec![KB]);
    // Still settled and closed despite the refusals.
    assert_eq!(w.sessions()[0].1, "closed");
}

#[test]
fn reads_the_ticket_as_the_person_with_their_signed_principal_forwarded() {
    let Some(w) = World::new() else { return };
    let desk = test_desk();
    let seen = Arc::clone(&desk.ticket_headers);
    let door = w.door(Some(&law()), Some(desk));
    let a = run(&door, &input(&[KB_ASK, TICKET_ASK]));
    assert_eq!(s(data(&a), "status"), "ok", "{}", a.compact());
    // `forwardedPrincipalHeaders(ctx)`: the edge's exact bytes, its signature and the region, nothing else.
    let mut sent = headers(&["agents:read", "agents:execute"], "basic");
    sent.retain(|(k, _)| k != "content-type");
    assert_eq!(*seen.lock().unwrap(), vec![sent]);
}

// ── Honesty: never fabricate what a tool could not return ─────────────────

#[test]
fn refuses_when_account_state_was_asked_and_missing() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.tickets = Vec::new();
    desk.account_override = Some(AccountRead::Ok(account(OTHER_USER, "tier2")));
    let door = w.door(Some(&law()), Some(desk));
    let a = run(
        &door,
        &input(&[
            KB_ASK,
            r#"{"tool":"support.ticket.read","ticket":null}"#,
            &account_ask(OTHER_USER),
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "refuse", "{}", a.compact());
    assert_eq!(s(d, "reason"), "account_state_missing");
    assert_eq!(s(d, "userMessageKey"), "agents.support.unavailable");
    let got: Vec<(&str, &str)> = arr(d, "unanswered")
        .iter()
        .map(|u| (s(u, "refusedBy"), s(u, "reason")))
        .collect();
    assert_eq!(
        got,
        [
            ("tool", "missing_fixture"),
            ("tool", "account_owner_mismatch")
        ]
    );
    assert_eq!(s(d.get("metering").unwrap(), "billedAmount"), "0");
    assert_eq!(w.sessions()[0].1, "closed");
}

#[test]
fn grounds_a_reply_from_the_published_catalog_and_account_grounding() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.articles = vec![account_access()];
    desk.accounts = vec![account(USER, "basic")];
    let door = w.door(Some(&law()), Some(desk));
    let grounding = format!(
        r#"{{"tool":"identity.account.read","accountGrounding":{{"status":"read","state":{{"userId":"{USER}","status":"active","kycTier":"basic"}},"readAt":"2026-08-12T00:00:00.000Z"}}}}"#
    );
    let a = run(
        &door,
        &input(&[
            r#"{"tool":"support.kb.search","kbQuery":"account","limit":20}"#,
            &grounding,
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok", "{}", a.compact());
    assert_eq!(
        arr(d, "citedArticleKeys"),
        &[Json::str("kb-account-access")]
    );
    assert!(arr(d, "findings").iter().any(|f| f.get("account")
        == Some(&parse(&format!(
            r#"{{"userId":"{USER}","status":"active","kycTier":"basic"}}"#
        )))));
    assert_eq!(s(d.get("metering").unwrap(), "billedAmount"), "0");
}

fn account_missing(desk: FixtureDesk, account: &str, want: &str) {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), Some(desk));
    let a = run(
        &door,
        &input(&[
            r#"{"tool":"support.kb.search","kbQuery":"account","limit":20}"#,
            account,
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "refuse", "{}", a.compact());
    assert_eq!(s(d, "reason"), "account_state_missing");
    assert_eq!(s(d, "userMessageKey"), "agents.support.unavailable");
    let got: Vec<(&str, &str)> = arr(d, "unanswered")
        .iter()
        .map(|u| (s(u, "tool"), s(u, "reason")))
        .collect();
    assert_eq!(got, [("identity.account.read", want)]);
    assert_eq!(s(d.get("metering").unwrap(), "billedAmount"), "0");
    assert_eq!(w.sessions()[0].1, "closed");
}

#[test]
fn refuses_when_account_grounding_is_plane_dark() {
    let mut desk = test_desk();
    desk.articles = vec![account_access()];
    desk.unread_accounts = true;
    account_missing(
        desk,
        r#"{"tool":"identity.account.read","accountGrounding":{"status":"unread","reason":"plane_dark"}}"#,
        "account_plane_dark",
    );
}

#[test]
fn refuses_when_the_account_read_is_unreachable() {
    let mut desk = test_desk();
    desk.articles = vec![account_access()];
    desk.account_override = Some(AccountRead::Unreachable);
    account_missing(desk, r#"{"tool":"identity.account.read"}"#, "no_live_kb");
}

#[test]
fn escalates_when_the_kb_query_misses_the_catalog_but_other_reads_worked() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.articles = vec![article(
        "kb-orders-status",
        "support.kb.orders_status.title",
        "support.kb.orders_status.body",
    )];
    let door = w.door(Some(&law()), Some(desk));
    let a = run(
        &door,
        &input(&[
            r#"{"tool":"support.kb.search","kbQuery":"definitely-not-an-article-xyz","limit":20}"#,
            &account_ask(USER),
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "escalate", "{}", a.compact());
    assert_eq!(s(d, "reason"), "kb_no_hit");
    assert_eq!(s(d, "userMessageKey"), "agents.support.escalated");
    assert_eq!(s(d.get("metering").unwrap(), "billedAmount"), "0");
}

#[test]
fn refuses_the_whole_run_when_no_data_source_was_reachable() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.articles = Vec::new();
    desk.accounts = Vec::new();
    desk.unread_accounts = true;
    let door = w.door(Some(&law()), Some(desk));
    let a = run(
        &door,
        &input(&[
            r#"{"tool":"support.kb.search","articles":null,"limit":20}"#,
            r#"{"tool":"identity.account.read","account":null}"#,
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "refuse", "{}", a.compact());
    assert_eq!(s(d, "reason"), "no_grounded_read");
    assert_eq!(s(d, "userMessageKey"), "agents.support.unavailable");
    assert_eq!(arr(d, "unanswered").len(), 2);
    let Json::Object(fields) = d else { panic!() };
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "status",
            "reason",
            "userMessageKey",
            "unanswered",
            "metering"
        ]
    );
    let sessions = w.sessions();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].1, "closed");
}

#[test]
fn escalates_rather_than_answering_when_the_kb_missed_but_other_reads_worked() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.articles = Vec::new();
    let door = w.door(Some(&law()), Some(desk));
    let a = run(
        &door,
        &input(&[
            r#"{"tool":"support.kb.search","articles":null,"limit":20}"#,
            &account_ask(USER),
        ]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "escalate", "{}", a.compact());
    assert_eq!(s(d, "reason"), "kb_no_hit");
    let findings = arr(d, "findings");
    assert_eq!(findings.len(), 1);
    assert_eq!(s(&findings[0], "tool"), "identity.account.read");
    let cf = d.get("caseFile").unwrap();
    assert_eq!(s(cf, "reason"), "kb_no_hit");
    assert_eq!(cf.get("moneyRequest"), Some(&Json::Bool(false)));
    assert_eq!(
        cf.get("accounts").unwrap(),
        &parse(&format!(
            r#"[{{"userId":"{USER}","status":"active","kycTier":"tier2"}}]"#
        ))
    );
    assert!(cf.get("balance").is_none());
    assert_eq!(w.sessions()[0].1, "closed");
}

#[test]
fn escalates_as_a_closed_door_when_the_guardrail_refused_the_kb_read() {
    let Some(w) = World::new() else { return };
    w.register(
        &guardrail()
            .unwrap()
            .clone_with(|g| g.tools.retain(|t| t.name != KB)),
    );
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(&door, &input(&[KB_ASK, &account_ask(USER)]));
    let d = data(&a);
    assert_eq!(s(d, "status"), "escalate", "{}", a.compact());
    assert_eq!(s(d, "reason"), "desk_refused");
    assert_eq!(w.executed(), vec!["identity.account.read"]);
    assert_eq!(w.refused(), vec![KB]);
}

#[test]
fn a_padded_tool_is_the_trimmed_tool_and_a_fractional_page_is_refused() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), Some(test_desk()));
    let a = run(
        &door,
        &input(&[r#"{"tool":" support.kb.search ","kbQuery":"withdrawal","limit":2.5e0}"#]),
    );
    // A fractional page size is refused at the input, as zod's int check does.
    assert_eq!(s(a.get("error").unwrap(), "code"), "BAD_REQUEST");
    let a = run(
        &door,
        &input(&[r#"{"tool":" support.kb.search ","kbQuery":"withdrawal","limit":2}"#]),
    );
    let d = data(&a);
    assert_eq!(s(d, "status"), "ok", "{}", a.compact());
    // The padded tool is the trimmed tool on the action log, and the one session it opened.
    assert_eq!(w.executed(), vec![KB]);
    assert_eq!(w.sessions().len(), 1);
}

// ── Free outcomes, before a session exists ─────────────────────────────────

/// (name, law, a desk, input, status, reason).
type FreeCase<'a> = (&'a str, Option<String>, bool, Json, &'a str, &'a str);

#[test]
fn every_free_outcome_opens_no_session_and_bills_nothing() {
    let Some(w) = World::new() else { return };
    let account = account_ask(USER);
    let cases: Vec<FreeCase<'_>> = vec![
        // (name, law, desk, input, status, reason)
        (
            "a money request",
            Some(law()),
            true,
            parse(&format!(
                r#"{{"plane":"live","kbCatalog":{CATALOG},"moneyRequest":true,"asks":[{KB_ASK}]}}"#
            )),
            "escalate",
            "money_request",
        ),
        (
            "a money request, the KB dark",
            Some(law()),
            true,
            parse(&format!(
                r#"{{"plane":"live","moneyRequest":true,"asks":[{KB_ASK},{account}]}}"#
            )),
            "escalate",
            "money_request",
        ),
        (
            "no KB read asked",
            Some(law()),
            true,
            input(&[&account]),
            "escalate",
            "kb_no_hit",
        ),
        (
            "an ungrounded KB plane",
            Some(law()),
            false,
            parse(&format!(
                r#"{{"plane":"live","kbCatalog":null,"asks":[{{"tool":"support.kb.search","kbQuery":"withdrawal-hold","limit":20}},{account}]}}"#
            )),
            "refuse",
            "kb_plane_ungrounded",
        ),
        (
            "an empty catalog",
            Some(law()),
            false,
            parse(
                r#"{"plane":"live","kbCatalog":[],"asks":[{"tool":"support.kb.search","kbQuery":"account","limit":20}]}"#,
            ),
            "refuse",
            "kb_plane_ungrounded",
        ),
        (
            "no desk port",
            Some(law()),
            false,
            input(&[KB_ASK, &account]),
            "refuse",
            "no_live_kb",
        ),
        (
            "smuggled articles, the KB dark",
            Some(law()),
            true,
            parse(&format!(
                r#"{{"plane":"live","asks":[{KB_ASK},{account}]}}"#
            )),
            "refuse",
            "kb_plane_ungrounded",
        ),
        (
            "a dark desk",
            Some(law()),
            true,
            parse(&format!(
                r#"{{"plane":"dark","kbCatalog":{CATALOG},"asks":[{KB_ASK}]}}"#
            )),
            "refuse",
            "desk_plane_dark",
        ),
        (
            "an unpublished law",
            None,
            true,
            input(&[KB_ASK]),
            "refuse",
            "tier_law_blank",
        ),
        (
            "no asked tool granted",
            Some(law_of(&["support.ticket.read"])),
            true,
            input(&[KB_ASK]),
            "refuse",
            "tier_not_granted",
        ),
        (
            "nothing asked",
            Some(law()),
            true,
            input(&[]),
            "refuse",
            "kb_plane_ungrounded",
        ),
    ];
    for (name, laws, desk, body, status, reason) in cases {
        let door = w.door(laws.as_deref(), desk.then(test_desk));
        let a = run(&door, &body);
        let d = data(&a);
        assert_eq!(
            (s(d, "status"), s(d, "reason")),
            (status, reason),
            "{name}: {}",
            a.compact()
        );
        unmetered(d);
        if status == "escalate" {
            let cf = d.get("caseFile").unwrap();
            assert_eq!(arr(cf, "findings").len(), 0, "{name}");
            assert_eq!(arr(cf, "accounts").len(), 0, "{name}");
            assert_eq!(
                cf.get("moneyRequest"),
                Some(&Json::Bool(reason == "money_request")),
                "{name}"
            );
        } else {
            assert!(
                d.get("findings").is_none() && d.get("citedArticleKeys").is_none(),
                "{name}"
            );
        }
    }
    assert!(w.sessions().is_empty());
    assert!(w.actions().is_empty());
}

// ── support.runSession route (`run-session-route.test.ts`) ─────────────────

#[test]
fn the_route_refuses_before_any_session() {
    let Some(w) = World::new() else { return };
    let door = w.door(Some(&law()), None);
    // A signed tier the stored law does not grant refuses tier_not_granted and bills 0.
    let a = run_as(
        &door,
        &input(&[KB_ASK]),
        &["agents:read", "agents:execute"],
        "none",
    );
    let d = data(&a);
    assert_eq!(
        (s(d, "status"), s(d, "reason")),
        ("refuse", "tier_not_granted")
    );
    unmetered(d);
    // agents:execute is required.
    let a = run_as(&door, &input(&[KB_ASK]), &["agents:read"], "basic");
    assert_eq!(s(a.get("error").unwrap(), "code"), "FORBIDDEN");
    // A body naming its own tier or law is rejected before the gate.
    for extra in [r#""userTier":"basic""#, r#""law":{"published":true}"#] {
        let body = parse(&format!(r#"{{"plane":"live","asks":[{KB_ASK}],{extra}}}"#));
        let a = run_as(&door, &body, &["agents:read", "agents:execute"], "none");
        assert_eq!(s(a.get("error").unwrap(), "code"), "BAD_REQUEST");
    }
    // The ask list is capped.
    let asks = vec![KB_ASK; 21];
    let a = run(
        &door,
        &parse(&format!(
            r#"{{"plane":"dark","asks":[{}]}}"#,
            asks.join(",")
        )),
    );
    assert_eq!(s(a.get("error").unwrap(), "code"), "BAD_REQUEST");
    assert!(w.sessions().is_empty());
}

// ── The thrown path ────────────────────────────────────────────────────────

#[test]
fn settles_and_closes_even_when_the_run_throws() {
    let Some(w) = World::new() else { return };
    let mut desk = test_desk();
    desk.search_fails = true;
    let door = w.door(Some(&law()), Some(desk));
    let a = run(&door, &input(&[KB_ASK]));
    let e = a.get("error").unwrap_or_else(|| panic!("{}", a.compact()));
    assert_eq!(s(e, "code"), "INTERNAL_SERVER_ERROR");
    // No leaked open session; the failed read is on the log.
    let sessions = w.sessions();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].1, "closed");
    assert_eq!(w.tools_with("failed"), vec![KB]);
}
