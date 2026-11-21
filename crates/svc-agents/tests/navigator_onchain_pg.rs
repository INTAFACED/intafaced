//! The navigator's on-chain calls against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose
//! admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner.
//! Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/navigator/onchain-routes.db.test.ts`, through the `AgentsDoor` with a
//! signed principal. The chain, the signer, identity's linked wallets and its freeze read are fakes, as there; the
//! session is the runtime's own row (the TypeScript stubs `deps.session` with the same four sessions).
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
use service_kit::server::Request;
use support::TestDb;
use svc_agents::db;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::RoutingTable;
use svc_agents::metering::Metering;
use svc_agents::navigator::onchain::abi::{self, Spec};
use svc_agents::navigator::onchain::ports::{
    Chain, Freeze, Linked, LinkedWallets, LiveGrant, Market, Mined, PoolTokens, SelfFreeze,
    SendError, Sender, SessionCall, Token,
};
use svc_agents::navigator::onchain::store;
use svc_agents::runtime::Runtime;

const SECRET: &str = "an-agents-navigator-onchain-test-secret";
const USER: &str = "11111111-1111-4111-8111-111111111119";
const OTHER: &str = "22222222-2222-4222-8222-222222222229";
const SESSION: &str = "33333333-3333-4333-8333-333333333339";
const OTHER_SESSION: &str = "44444444-4444-4444-8444-444444444449";
const SCANNER_SESSION: &str = "55555555-5555-4555-8555-555555555559";
const CLOSED_SESSION: &str = "66666666-6666-4666-8666-666666666669";
const SIGNER: &str = "0x00000000000000000000000000000000005e0019";
const ACCOUNT: &str = "0x00000000000000000000000000000000000A0019";
const ROUTER: &str = "0x00000000000000000000000000000000000b0019";
const SWAP: &str = "0x8f2a8b5e";
const POOL: &str = "0x00000000000000000000000000000000000c0019";
const WETH: &str = "0x0000000000000000000000000000000000e7e700";
const TOKEN_B: &str = "0x00000000000000000000000000000000000b0b00";
const TOKEN_A: &str = "0x00000000000000000000000000000000000a11ce";
const AB_POOL: &str = "0x00000000000000000000000000000000000d0019";
const OWNER: &str = "0x00000000000000000000000000000000000f0019";
const ROUTER_SWAP: &str = "0x7b32b50e";
const ETH: u128 = 1_000_000_000_000_000_000;
const TRADE: &str = "TEST: swap 0.1 TEST Wrapped ETH for TEST Token B";
const BIG: &str = "TEST: swap 2 TEST Wrapped ETH for TEST Token B";

fn hash_a() -> String {
    format!("0x{}", "aa".repeat(32))
}
fn hash_b() -> String {
    format!("0x{}", "bb".repeat(32))
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// What the fakes answer, shared with the test so a case can change it between calls.
struct State {
    grant: Option<LiveGrant>,
    receipt: Option<Mined>,
    sent: Vec<SessionCall>,
    sender_fails: Option<&'static str>,
    linked: BTreeMap<String, Option<Linked>>,
    frozen: BTreeMap<String, String>,
    freeze_down: bool,
}

type Shared = Arc<Mutex<State>>;

/// `liveGrant(over)`: a live grant with a 1 TEST ETH cap on the router and both pools.
fn live_grant() -> LiveGrant {
    LiveGrant {
        live: true,
        spec_hash: hash_a(),
        valid_after: 0,
        valid_until: 2_000_000_000,
        spend_limit_wei: ETH,
        spent_wei: 0,
        targets: [ROUTER, POOL, AB_POOL]
            .iter()
            .map(|a| a.to_lowercase())
            .collect(),
        selectors: vec![ROUTER_SWAP.to_owned()],
    }
}

struct FakeChain {
    s: Shared,
    quote_zero: bool,
}

impl Chain for FakeChain {
    fn grant(&self, _account: &str, _key: &str) -> Result<Option<LiveGrant>, String> {
        Ok(self.s.lock().unwrap().grant.clone())
    }
    fn owner(&self, _account: &str) -> Result<String, String> {
        Ok(OWNER.to_owned())
    }
    fn pool(&self, pool: &str) -> Result<PoolTokens, String> {
        let t = |address: &str, symbol: &str, name: &str, decimals: u32| Token {
            address: address.to_owned(),
            symbol: symbol.to_owned(),
            name: name.to_owned(),
            decimals,
        };
        let tokens = if pool.to_lowercase() == POOL.to_lowercase() {
            vec![
                t(WETH, "TESTWETH", "TEST Wrapped ETH", 18),
                t(TOKEN_B, "TESTB", "TEST Token B", 18),
            ]
        } else {
            vec![
                t(TOKEN_A, "TESTA", "TEST Token A", 6),
                t(TOKEN_B, "TESTB", "TEST Token B", 18),
            ]
        };
        Ok(PoolTokens {
            pool: pool.to_lowercase(),
            tokens,
        })
    }
    fn quote(
        &self,
        _router: &str,
        _pool: &str,
        _token: &str,
        amount_in: u128,
    ) -> Result<u128, String> {
        Ok(if self.quote_zero { 0 } else { amount_in * 1000 })
    }
    fn receipt(&self, _hash: &str) -> Option<Mined> {
        self.s.lock().unwrap().receipt
    }
}

struct FakeSender(Shared);

impl Sender for FakeSender {
    fn send(&self, call: &SessionCall) -> Result<String, SendError> {
        let mut s = self.0.lock().unwrap();
        match s.sender_fails {
            Some("refused") => Err(SendError::Refused(400)),
            Some(_) => {
                // Broadcast, then the answer was lost: the chain may have the call.
                s.sent.push(call.clone());
                Err(SendError::Unknown("TEST: the signer timed out".to_owned()))
            }
            None => {
                s.sent.push(call.clone());
                Ok(format!("0x{:0>64}", s.sent.len()))
            }
        }
    }
}

struct FakeLinked(Shared);

impl LinkedWallets for FakeLinked {
    fn read(&self, user_id: &str) -> Option<Linked> {
        match self.0.lock().unwrap().linked.get(user_id) {
            Some(l) => l.clone(),
            None => Some(Linked::Usable(vec![])),
        }
    }
}

/// `MemorySelfFreezeRead`.
struct FakeFreeze(Shared);

impl SelfFreeze for FakeFreeze {
    fn read(&self, user_id: &str) -> Result<Freeze, String> {
        let s = self.0.lock().unwrap();
        if s.freeze_down {
            return Err("TEST: identity down".to_owned());
        }
        Ok(match s.frozen.get(user_id) {
            Some(since) => Freeze::Frozen {
                since: Some(since.clone()),
            },
            None => Freeze::Open,
        })
    }
}

/// `deps(over)`: which dependencies a case leaves out.
#[derive(Default, Clone, Copy)]
struct Over {
    no_signer: bool,
    no_sender: bool,
    no_market: bool,
    no_chain: bool,
    no_linked: bool,
    no_freeze: bool,
    quote_zero: bool,
}

struct World {
    db: TestDb,
    s: Shared,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let mut c = db.client();
        // Each session holds a guardrail as an opened session does; the TypeScript's stubbed `deps.session` reads none.
        for (id, user, agent) in [
            (SESSION, USER, "navigator"),
            (OTHER_SESSION, OTHER, "navigator"),
            (SCANNER_SESSION, USER, "scanner"),
            (CLOSED_SESSION, USER, "navigator"),
        ] {
            let guardrail = format!(
                r#"{{"agentId":"{agent}","version":1,"capacityMode":"confirm_each","tools":[],"limits":{{"maxActionsPerSession":20,"maxOutputTokensPerCall":256,"maxSpendPerSession":null,"allowedModules":["trade"],"allowedTasks":["plan"]}}}}"#
            );
            c.execute(
                "INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text::jsonb, 1)",
                &[&id, &user, &agent, &guardrail],
            )
            .unwrap();
        }
        c.execute(
            "UPDATE agents.agent_sessions SET status = 'closed', closed_at = now() WHERE id = $1::text::uuid",
            &[&CLOSED_SESSION],
        )
        .unwrap();
        let mut linked = BTreeMap::new();
        linked.insert(
            USER.to_owned(),
            Some(Linked::Usable(vec![OWNER.to_owned()])),
        );
        Some(World {
            db,
            s: Arc::new(Mutex::new(State {
                grant: Some(live_grant()),
                receipt: Some(Mined::Success),
                sent: Vec::new(),
                sender_fails: None,
                linked,
                frozen: BTreeMap::new(),
                freeze_down: false,
            })),
        })
    }

    fn set(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.s.lock().unwrap());
    }

    fn sent(&self) -> usize {
        self.s.lock().unwrap().sent.len()
    }

    fn count(&self, table: &str, user: &str) -> i64 {
        self.db
            .client()
            .query_one(
                &format!("SELECT count(*) FROM agents.{table} WHERE user_id = $1"),
                &[&user],
            )
            .unwrap()
            .get(0)
    }

    fn exec(&self, sql: &str) {
        self.db.client().batch_execute(sql).unwrap();
    }

    fn door(&self, over: Over) -> AgentsDoor {
        let mut rt = Runtime::unwired();
        let d = &mut rt.navigator.onchain;
        d.signer = (!over.no_signer).then(|| SIGNER.to_owned());
        if !over.no_sender {
            d.sender = Some(Box::new(FakeSender(self.s.clone())));
        }
        if !over.no_market {
            d.market = Some(Market {
                router: ROUTER.to_owned(),
                spend_token: WETH.to_owned(),
                pools: vec![POOL.to_owned(), AB_POOL.to_owned()],
                slippage_bps: 100,
            });
        }
        if !over.no_chain {
            d.chain = Some(Box::new(FakeChain {
                s: self.s.clone(),
                quote_zero: over.quote_zero,
            }));
        }
        if !over.no_linked {
            d.linked_wallets = Some(Box::new(FakeLinked(self.s.clone())));
        }
        if !over.no_freeze {
            d.self_freeze = Some(Box::new(FakeFreeze(self.s.clone())));
        }
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: None,
                keys: None,
            },
            env,
            now: svc_agents::door::system_now,
            store: db::open(&self.db.url, "svc-agents", 4, false).unwrap(),
            gateway: GatewaySlice {
                gateway: Arc::new(Gateway::new(vec![], RoutingTable::default())),
                fee_asset_id: "IFC".to_owned(),
                metering_enabled: Some(false),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: Metering::unwired("IFC", 60),
            runtime: rt,
            advisors: svc_agents::advisors::Advisors::unwired(),
            own: svc_agents::own::Own::unwired(),
            background: svc_agents::background::Settings::default(),
        })
        .unwrap()
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

/// `ctxOf(userId, ['agents:read', 'agents:execute'], extra)`.
fn principal(user: &str, kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("77777777-7777-4777-8777-777777777779")),
        (
            "scopes",
            Json::Array(vec![Json::str("agents:read"), Json::str("agents:execute")]),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ];
    if let Some(kid) = kid {
        fields.push(("kid", Json::str(kid)));
    }
    let raw = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

/// One caller of one door: `as(userId, over, extra)`.
struct As<'a> {
    door: &'a AgentsDoor,
    headers: Vec<(String, String)>,
}

/// An answer: the data, or the refusal's tRPC code and message.
type Answer = Result<Json, (String, String)>;

fn answer(status: u16, body: &str) -> Answer {
    let v = json::parse(body).unwrap();
    if status == 200 {
        return Ok(v
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap());
    }
    let e = v.get("error").unwrap();
    let text = |j: Option<&Json>| match j {
        Some(Json::String(s)) => s.clone(),
        _ => panic!("no code or message: {body}"),
    };
    Err((
        text(e.get("data").and_then(|d| d.get("code"))),
        text(e.get("message")),
    ))
}

impl As<'_> {
    fn query(&self, path: &str, input: Option<&Json>) -> Answer {
        let url = match input {
            None => format!("/trpc/navigator.{path}"),
            Some(i) => {
                let enc: String = i
                    .compact()
                    .bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() {
                            char::from(b).to_string()
                        } else {
                            format!("%{b:02X}")
                        }
                    })
                    .collect();
                format!("/trpc/navigator.{path}?input={enc}")
            }
        };
        let res = self.door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &self.headers,
            body: "",
        });
        answer(res.status, &res.body)
    }

    fn mutate(&self, path: &str, input: &Json) -> Answer {
        let body = input.compact();
        let mut headers = self.headers.clone();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let url = format!("/trpc/navigator.{path}");
        let res = self.door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: &body,
        });
        answer(res.status, &res.body)
    }

    fn signer(&self, chain_id: i64) -> Answer {
        self.query(
            "onchain.signer",
            Some(&Json::obj([("chainId", Json::int(chain_id))])),
        )
    }
    fn bind(&self, grant: &Json) -> Answer {
        self.mutate("onchain.bind", grant)
    }
    fn revoke(&self) -> Answer {
        self.mutate("onchain.revoke", &account_input(ACCOUNT))
    }
    fn binding(&self, account: &str) -> Answer {
        self.query("onchain.binding", Some(&account_input(account)))
    }
    fn ask(&self, session: &str, request: &str, text: &str) -> Answer {
        self.mutate(
            "ask",
            &Json::obj([
                ("sessionId", Json::str(session)),
                ("requestId", Json::str(request)),
                ("text", Json::str(text)),
            ]),
        )
    }
    fn orders(&self, session: &str) -> Answer {
        self.query(
            "orders",
            Some(&Json::obj([("sessionId", Json::str(session))])),
        )
    }
    fn trading(&self) -> Answer {
        self.query("trading", None)
    }
}

fn as_<'a>(door: &'a AgentsDoor, user: &str) -> As<'a> {
    As {
        door,
        headers: principal(user, None),
    }
}

fn account_input(account: &str) -> Json {
    Json::obj([
        ("chainId", Json::int(84_532)),
        ("account", Json::str(account)),
    ])
}

fn strs(v: &[&str]) -> Json {
    Json::Array(v.iter().map(|s| Json::str(*s)).collect())
}

/// `grant`, with the fields a case changes.
fn grant_with(
    spec_hash: &str,
    cap: Json,
    valid_until: Json,
    targets: &[&str],
    selectors: &[&str],
) -> Json {
    Json::obj([
        ("chainId", Json::int(84_532)),
        ("account", Json::str(ACCOUNT)),
        ("specHash", Json::str(spec_hash)),
        ("spendLimitWei", cap),
        ("validUntil", valid_until),
        ("targets", strs(targets)),
        ("selectors", strs(selectors)),
    ])
}

fn grant() -> Json {
    grant_with(
        &hash_a(),
        Json::str("1000000000000000000"),
        Json::int(2_000_000_000),
        &[ROUTER],
        &[SWAP],
    )
}

/// `liveGrantBound`.
fn bound() -> Json {
    grant_with(
        &hash_a(),
        Json::str("1000000000000000000"),
        Json::int(2_000_000_000),
        &[ROUTER, POOL, AB_POOL],
        &[ROUTER_SWAP],
    )
}

fn with(v: &Json, key: &str, value: Json) -> Json {
    let Json::Object(mut fields) = v.clone() else {
        panic!("not an object")
    };
    match fields.iter_mut().find(|(k, _)| k == key) {
        Some(f) => f.1 = value,
        None => fields.push((key.to_owned(), value)),
    }
    Json::Object(fields)
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is {other:?} in {}", v.compact()),
    }
}

fn message(a: &Answer) -> String {
    match a {
        Err((_, m)) => m.clone(),
        Ok(v) => panic!("not refused: {}", v.compact()),
    }
}

fn refused(a: &Answer, code: &str, msg: &str) {
    match a {
        Err((c, m)) => assert_eq!((c.as_str(), m.as_str()), (code, msg)),
        Ok(v) => panic!("not refused: {}", v.compact()),
    }
}

fn order_of(a: &Answer) -> Json {
    let v = a.as_ref().unwrap_or_else(|e| panic!("refused: {e:?}"));
    assert_eq!(s(v, "kind"), "order");
    v.get("order").cloned().unwrap()
}

// ── navigator.onchain.signer ───────────────────────────────────────────────

#[test]
fn the_signer_is_named_on_the_test_network_and_mainnet_no_signer_and_other_chains_refuse_by_code() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    assert_eq!(
        me.signer(84_532).unwrap(),
        Json::obj([
            ("signer", Json::str(SIGNER)),
            ("chainId", Json::int(84_532)),
            ("network", Json::str("testnet")),
            (
                "pools",
                strs(&[&POOL.to_lowercase(), &AB_POOL.to_lowercase()])
            ),
            ("router", Json::str(ROUTER.to_lowercase())),
        ])
    );
    refused(&me.signer(8_453), "PRECONDITION_FAILED", "audit.external");
    let unsigned = w.door(Over {
        no_signer: true,
        ..Over::default()
    });
    assert_eq!(message(&as_(&unsigned, USER).signer(84_532)), "rail.crypto");
    assert_eq!(message(&me.signer(1)), "agents.onchain_chain_unsupported");
}

// ── navigator.onchain.bind ─────────────────────────────────────────────────

#[test]
fn a_blank_cap_and_a_missing_expiry_refuse_by_name_and_store_nothing() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    assert_eq!(
        message(&me.bind(&with(&grant(), "spendLimitWei", Json::str("")))),
        "agents.session_key_cap_unset"
    );
    assert_eq!(
        message(&me.bind(&with(&grant(), "spendLimitWei", Json::Null))),
        "agents.session_key_cap_unset"
    );
    assert_eq!(
        message(&me.bind(&with(&grant(), "validUntil", Json::Null))),
        "agents.session_key_expiry_unset"
    );
    refused(
        &me.bind(&with(&grant(), "selectors", strs(&[SWAP, "0x095ea7b3"]))),
        "FORBIDDEN",
        "agents.session_key_selector_forbidden",
    );
    let unsigned = w.door(Over {
        no_signer: true,
        ..Over::default()
    });
    assert_eq!(message(&as_(&unsigned, USER).bind(&grant())), "rail.crypto");
    assert_eq!(
        message(&me.bind(&with(&grant(), "chainId", Json::int(8_453)))),
        "audit.external"
    );
    assert_eq!(w.count("navigator_onchain_bindings", USER), 0);
}

#[test]
fn the_configured_signer_is_bound_never_a_key_from_the_body_keyed_by_chain_account_and_key() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let row = as_(&door, USER)
        .bind(&with(
            &grant(),
            "sessionKey",
            Json::str("0x000000000000000000000000000000000000dead"),
        ))
        .unwrap();
    assert_eq!(s(&row, "sessionKey"), SIGNER);
    assert_eq!(s(&row, "account"), ACCOUNT.to_lowercase());
    assert_eq!(s(&row, "spendLimitWei"), "1000000000000000000");
    assert_eq!(row.get("validUntil"), Some(&Json::int(2_000_000_000)));
    assert_eq!(row.get("targets"), Some(&strs(&[ROUTER])));
    assert_eq!(row.get("selectors"), Some(&strs(&[SWAP])));
    assert_eq!(s(&row, "specHash"), hash_a());
    assert_eq!(
        s(&row, "bindKey"),
        format!(
            "agents:onchain:navigator:84532:{}:{SIGNER}",
            ACCOUNT.to_lowercase()
        )
    );
    assert_eq!(row.get("revokeRequestedAt"), Some(&Json::Null));
}

#[test]
fn a_bind_retried_after_its_reply_was_lost_returns_the_first_row() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    let first = me.bind(&grant()).unwrap();
    let (again, concurrent) = std::thread::scope(|sc| {
        let a = sc.spawn(|| as_(&door, USER).bind(&grant()).unwrap());
        let b = sc.spawn(|| as_(&door, USER).bind(&grant()).unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(s(&again, "id"), s(&first, "id"));
    assert_eq!(s(&concurrent, "id"), s(&first, "id"));
    assert_eq!(s(&again, "createdAt"), s(&first, "createdAt"));
    assert_eq!(w.count("navigator_onchain_bindings", USER), 1);
}

#[test]
fn a_new_scope_for_the_same_key_replaces_what_was_prepared_and_clears_a_revoke_request_in_one_row()
{
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    let first = me.bind(&grant()).unwrap();
    me.revoke().unwrap();
    // The same scope again is a retry: the revoke request stands.
    assert_ne!(
        me.bind(&grant()).unwrap().get("revokeRequestedAt"),
        Some(&Json::Null)
    );
    let next = me
        .bind(&grant_with(
            &hash_b(),
            Json::str("5"),
            Json::int(2_000_000_100),
            &[ROUTER],
            &[SWAP],
        ))
        .unwrap();
    assert_eq!(s(&next, "id"), s(&first, "id"));
    assert_eq!(s(&next, "specHash"), hash_b());
    assert_eq!(s(&next, "spendLimitWei"), "5");
    assert_eq!(next.get("validUntil"), Some(&Json::int(2_000_000_100)));
    assert_eq!(next.get("revokeRequestedAt"), Some(&Json::Null));
    assert_eq!(w.count("navigator_onchain_bindings", USER), 1);
}

#[test]
fn only_the_person_binds_a_delegated_key_may_not() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let key = As {
        door: &door,
        headers: principal(USER, Some("key-1")),
    };
    assert_eq!(key.bind(&grant()).unwrap_err().0, "FORBIDDEN");
}

// ── navigator.onchain.revoke and binding ───────────────────────────────────

#[test]
fn binding_reads_null_before_a_bind_the_row_after_and_a_revoke_marks_it_once() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    assert_eq!(
        me.binding(ACCOUNT).unwrap(),
        Json::obj([("binding", Json::Null)])
    );
    me.bind(&grant()).unwrap();
    let read = me.binding(&ACCOUNT.to_lowercase()).unwrap();
    let b = read.get("binding").unwrap();
    assert_eq!(s(b, "specHash"), hash_a());
    assert_eq!(b.get("revokeRequestedAt"), Some(&Json::Null));
    let asked = me.revoke().unwrap();
    let at = s(&asked, "revokeRequestedAt");
    assert_eq!(s(&me.revoke().unwrap(), "revokeRequestedAt"), at);
    assert_eq!(
        s(
            me.binding(ACCOUNT).unwrap().get("binding").unwrap(),
            "revokeRequestedAt"
        ),
        at
    );
}

#[test]
fn a_revoke_with_nothing_bound_is_not_found() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    refused(
        &as_(&door, USER).revoke(),
        "NOT_FOUND",
        "agents.onchain_binding_not_found",
    );
}

#[test]
fn another_persons_binding_is_never_shown_or_revoked() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let (me, other) = (as_(&door, USER), as_(&door, OTHER));
    other.bind(&grant()).unwrap();
    assert_eq!(
        me.binding(ACCOUNT).unwrap(),
        Json::obj([("binding", Json::Null)])
    );
    assert_eq!(me.revoke().unwrap_err().0, "NOT_FOUND");
    // The same account and key bound by this person is their own row, beside the other's.
    me.bind(&grant()).unwrap();
    assert_eq!(w.count("navigator_onchain_bindings", USER), 1);
    assert_eq!(w.count("navigator_onchain_bindings", OTHER), 1);
    assert_eq!(
        other
            .binding(ACCOUNT)
            .unwrap()
            .get("binding")
            .unwrap()
            .get("revokeRequestedAt"),
        Some(&Json::Null)
    );
}

// ── navigator.ask ──────────────────────────────────────────────────────────

fn no_usage(w: &World) {
    let n: i64 =
        w.db.client()
            .query_one(
                "SELECT count(*) FROM agents.usage_records WHERE session_id = $1::text::uuid",
                &[&SESSION],
            )
            .unwrap()
            .get(0);
    assert_eq!(n, 0);
}

#[test]
fn inside_the_cap_the_order_is_sent_once_tagged_as_the_assistant_with_no_approval_and_reads_filled()
{
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    let order = order_of(&me.ask(SESSION, "r-1", TRADE));
    let min_out = ETH / 10 * 1000 * 99 / 100;
    assert_eq!(s(&order, "sessionId"), SESSION);
    assert_eq!(
        s(&order, "orderKey"),
        format!("agents:navigator:order:{SESSION}:r-1")
    );
    assert_eq!(s(&order, "placedBy"), "assistant");
    assert_eq!(s(&order, "text"), TRADE);
    assert_eq!(s(&order, "tokenInSymbol"), "TESTWETH");
    assert_eq!(s(&order, "tokenOutSymbol"), "TESTB");
    assert_eq!(s(&order, "amountInWei"), (ETH / 10).to_string());
    // The pool's quote less the 1% bound.
    assert_eq!(s(&order, "minOutWei"), min_out.to_string());
    assert_eq!(s(&order, "status"), "filled");
    assert_eq!(s(&order, "txHash"), format!("0x{:0>64}", 1));
    let sent = w.s.lock().unwrap().sent.clone();
    assert_eq!(sent.len(), 1);
    // The one call a session key can make, from the Navigator's signer to the person's own account.
    assert_eq!(
        (sent[0].chain_id, sent[0].from.as_str(), sent[0].to.clone()),
        (84_532, SIGNER, ACCOUNT.to_lowercase())
    );
    // executeWithSession(spec, router, 0, swapExactIn(pool, WETH, 0.1, minOut, account)): no native value moves, and
    // the swap's output goes back to the person's own account. The encoder is held to viem's bytes by its own tests.
    let g = live_grant();
    let swap = abi::swap_exact_in(POOL, WETH, ETH / 10, min_out, ACCOUNT);
    let expected = abi::execute_with_session(
        &Spec {
            key: SIGNER.to_owned(),
            valid_after: g.valid_after,
            valid_until: 2_000_000_000,
            spend_limit_wei: ETH,
            targets: g.targets,
            selectors: g.selectors,
        },
        ROUTER,
        &swap,
    );
    assert_eq!(sent[0].data, expected);
    // The order is the Navigator's, not a run: nothing metered.
    no_usage(&w);
    let trading = me.trading().unwrap();
    let key = trading.get("key").unwrap();
    assert_eq!(s(key, "capWei"), ETH.to_string());
    assert_eq!(s(key, "spentWei"), (ETH / 10).to_string());
    assert_eq!(s(key, "leftWei"), (ETH * 9 / 10).to_string());
}

#[test]
fn a_retried_ask_is_the_first_order_sent_once_and_with_other_words_the_same_id_refuses() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    let first = order_of(&me.ask(SESSION, "r-1", TRADE));
    let again = order_of(&me.ask(SESSION, "r-1", TRADE));
    assert_eq!(s(&again, "id"), s(&first, "id"));
    assert_eq!(w.sent(), 1);
    assert_eq!(w.count("navigator_orders", USER), 1);
    refused(
        &me.ask(SESSION, "r-1", BIG),
        "CONFLICT",
        "agents.request_id_replay",
    );
    assert_eq!(w.sent(), 1);
}

#[test]
fn above_the_cap_it_refuses_naming_the_cap_before_anything_is_signed_or_stored() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    refused(
        &me.ask(SESSION, "r-2", BIG),
        "FORBIDDEN",
        "agents.navigator_trade_over_cap",
    );
    assert_eq!(w.sent(), 0);
    assert_eq!(w.count("navigator_orders", USER), 0);
    no_usage(&w);
}

#[test]
fn the_cap_is_cumulative_and_a_reverted_or_refused_order_frees_its_part() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    w.set(|st| st.grant.as_mut().unwrap().spent_wei = ETH * 5 / 10);
    for id in ["a", "b", "c", "d"] {
        order_of(&me.ask(SESSION, id, TRADE));
    }
    // 0.5 on the chain and 0.4 in orders: 0.1 left, so a fifth fits and a sixth does not.
    order_of(&me.ask(SESSION, "e", TRADE));
    assert_eq!(
        message(&me.ask(SESSION, "f", TRADE)),
        "agents.navigator_trade_over_cap"
    );
    assert_eq!(w.sent(), 5);
    w.exec("UPDATE agents.navigator_orders SET status = 'reverted' WHERE order_key LIKE '%:a'");
    order_of(&me.ask(SESSION, "g", TRADE));
    // Full again. Free 0.1 more; an order the signer refuses reaches no chain and frees its part, so the next one fits.
    w.exec("UPDATE agents.navigator_orders SET status = 'reverted' WHERE order_key LIKE '%:b'");
    w.set(|st| st.sender_fails = Some("refused"));
    let failed = order_of(&me.ask(SESSION, "h", TRADE));
    assert_eq!(
        (s(&failed, "status"), failed.get("txHash").cloned()),
        ("failed".to_owned(), Some(Json::Null))
    );
    w.set(|st| st.sender_fails = None);
    assert_eq!(
        s(&order_of(&me.ask(SESSION, "i", TRADE)), "status"),
        "filled"
    );
    assert_eq!(
        message(&me.ask(SESSION, "j", TRADE)),
        "agents.navigator_trade_over_cap"
    );
    assert_eq!(w.sent(), 7);
}

#[test]
fn two_asks_at_once_that_each_fit_but_not_together_give_one_order_and_one_refusal() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    as_(&door, USER).bind(&bound()).unwrap();
    w.set(|st| st.grant.as_mut().unwrap().spend_limit_wei = ETH * 15 / 100);
    let both = std::thread::scope(|sc| {
        let x = sc.spawn(|| as_(&door, USER).ask(SESSION, "x", TRADE));
        let y = sc.spawn(|| as_(&door, USER).ask(SESSION, "y", TRADE));
        [x.join().unwrap(), y.join().unwrap()]
    });
    assert_eq!(both.iter().filter(|a| a.is_ok()).count(), 1);
    let refusal = both.iter().find(|a| a.is_err()).unwrap();
    assert_eq!(message(refusal), "agents.navigator_trade_over_cap");
    assert_eq!(w.sent(), 1);
}

#[test]
fn a_signer_that_fails_after_it_may_have_broadcast_leaves_the_order_sending_holding_the_cap() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    w.set(|st| {
        st.grant.as_mut().unwrap().spend_limit_wei = ETH * 15 / 100;
        st.sender_fails = Some("unknown");
    });
    let o = order_of(&me.ask(SESSION, "u", TRADE));
    assert_eq!(
        (s(&o, "status"), o.get("txHash").cloned()),
        ("sending".to_owned(), Some(Json::Null))
    );
    w.set(|st| st.sender_fails = None);
    // The same ask again is that order, not a second send.
    assert_eq!(
        s(&order_of(&me.ask(SESSION, "u", TRADE)), "status"),
        "sending"
    );
    assert_eq!(w.sent(), 1);
    // It still holds 0.1 of the 0.15 cap, so a new ask of 0.1 is above what is left.
    assert_eq!(
        message(&me.ask(SESSION, "v", TRADE)),
        "agents.navigator_trade_over_cap"
    );
    assert_eq!(w.sent(), 1);
}

#[test]
fn with_no_signer_to_send_through_it_refuses_rail_crypto_and_writes_nothing() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    as_(&door, USER).bind(&bound()).unwrap();
    let unsent = w.door(Over {
        no_sender: true,
        ..Over::default()
    });
    assert_eq!(
        message(&as_(&unsent, USER).ask(SESSION, "n", TRADE)),
        "rail.crypto"
    );
    assert_eq!(w.count("navigator_orders", USER), 0);
}

#[test]
fn an_order_the_chain_has_not_mined_reads_sent_and_one_it_reverted_reads_reverted() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    w.set(|st| st.receipt = None);
    assert_eq!(
        s(&order_of(&me.ask(SESSION, "r-1", TRADE)), "status"),
        "sent"
    );
    w.set(|st| st.receipt = Some(Mined::Reverted));
    assert_eq!(
        s(&order_of(&me.ask(SESSION, "r-2", TRADE)), "status"),
        "reverted"
    );
}

#[test]
fn it_never_moves_money_out_with_or_without_a_key() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    for text in [
        format!("TEST: send 0.1 TEST Wrapped ETH to 0x{}", "12".repeat(20)),
        format!("TEST: transfer everything to 0x{}", "34".repeat(20)),
        "TEST: withdraw my TEST Wrapped ETH".to_owned(),
        format!(
            "TEST: can you swap 0.1 TEST Wrapped ETH and pay 0x{}?",
            "56".repeat(20)
        ),
    ] {
        refused(
            &me.ask(SESSION, &text, &text),
            "FORBIDDEN",
            "agents.navigator_money_out_forbidden",
        );
    }
    me.revoke().unwrap();
    assert_eq!(
        message(&me.ask(SESSION, "w", "TEST: withdraw it all")),
        "agents.navigator_money_out_forbidden"
    );
    assert_eq!(w.sent(), 0);
    assert_eq!(w.count("navigator_orders", USER), 0);
}

#[test]
fn with_no_live_key_it_refuses_none_bound_revoke_asked_or_the_chain_says_otherwise() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    let no_key = |a: Answer| refused(&a, "PRECONDITION_FAILED", "agents.navigator_no_live_key");
    no_key(me.ask(SESSION, "1", TRADE));
    me.bind(&bound()).unwrap();
    w.set(|st| st.grant.as_mut().unwrap().live = false);
    no_key(me.ask(SESSION, "2", TRADE));
    w.set(|st| st.grant = None);
    no_key(me.ask(SESSION, "3", TRADE));
    w.set(|st| st.grant = Some(live_grant()));
    me.revoke().unwrap();
    no_key(me.ask(SESSION, "4", TRADE));
    assert_eq!(me.trading().unwrap(), Json::obj([("key", Json::Null)]));
    assert_eq!(w.sent(), 0);
}

#[test]
fn what_it_cannot_place_is_refused_by_name() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    as_(&door, USER).bind(&bound()).unwrap();
    let ask = |text: &str, over: Over, id: &str| {
        let d = w.door(over);
        as_(&d, USER).ask(SESSION, &format!("{text}{id}"), text)
    };
    let none = Over::default();
    assert_eq!(
        message(&ask("TEST: buy something nice", none, "")),
        "agents.navigator_trade_unparsed"
    );
    assert_eq!(
        message(&ask("TEST: swap 1 TEST Gold for TEST Token B", none, "")),
        "agents.navigator_trade_unparsed"
    );
    assert_eq!(
        message(&ask(
            "TEST: swap 0.1 TEST Token A for TEST Token B",
            none,
            ""
        )),
        "agents.navigator_trade_cap_unit"
    );
    w.set(|st| st.grant.as_mut().unwrap().targets = vec![ROUTER.to_lowercase()]);
    assert_eq!(
        message(&ask(TRADE, none, "")),
        "agents.navigator_trade_out_of_scope"
    );
    w.set(|st| st.grant = Some(live_grant()));
    let market = Over {
        no_market: true,
        ..none
    };
    assert_eq!(
        message(&ask(TRADE, market, "market")),
        "agents.navigator_market_unset"
    );
    let chain = Over {
        no_chain: true,
        ..none
    };
    assert_eq!(
        message(&ask(TRADE, chain, "chain")),
        "agents.navigator_market_unset"
    );
    let signer = Over {
        no_signer: true,
        ..none
    };
    assert_eq!(message(&ask(TRADE, signer, "signer")), "rail.crypto");
    let zero = Over {
        quote_zero: true,
        ..none
    };
    assert_eq!(
        message(&ask(TRADE, zero, "quote")),
        "agents.navigator_trade_unquoted"
    );
    assert_eq!(w.sent(), 0);
    assert_eq!(w.count("navigator_orders", USER), 0);
}

#[test]
fn another_persons_account_is_never_traded() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let (me, other) = (as_(&door, USER), as_(&door, OTHER));
    me.bind(&bound()).unwrap();
    // OTHER types USER's account into a binding; the chain's grant to the shared Navigator key is USER's.
    other.bind(&bound()).unwrap();
    refused(
        &other.ask(OTHER_SESSION, "steal", TRADE),
        "FORBIDDEN",
        "agents.navigator_account_not_yours",
    );
    assert_eq!(other.trading().unwrap(), Json::obj([("key", Json::Null)]));
    assert_eq!(w.sent(), 0);
    assert_eq!(w.count("navigator_orders", OTHER), 0);
    // Linked wallets that cannot be read refuse too, never pass.
    w.set(|st| {
        st.linked.insert(USER.to_owned(), None);
    });
    assert_eq!(
        message(&me.ask(SESSION, "unread", TRADE)),
        "agents.navigator_account_unproven"
    );
    w.set(|st| {
        st.linked
            .insert(USER.to_owned(), Some(Linked::AccountInactive));
    });
    assert_eq!(
        message(&me.ask(SESSION, "inactive", TRADE)),
        "agents.navigator_account_unproven"
    );
    let unlinked = w.door(Over {
        no_linked: true,
        ..Over::default()
    });
    assert_eq!(
        message(&as_(&unlinked, USER).ask(SESSION, "none", TRADE)),
        "agents.navigator_account_unproven"
    );
    assert_eq!(w.sent(), 0);
}

#[test]
fn only_the_grant_the_person_prepared_is_traded() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    w.set(|st| st.grant.as_mut().unwrap().spec_hash = hash_b());
    assert_eq!(
        message(&me.ask(SESSION, "other-grant", TRADE)),
        "agents.navigator_no_live_key"
    );
    assert_eq!(w.sent(), 0);
}

#[test]
fn the_cap_is_the_accounts_orders_of_two_owners_count_together() {
    let w = world_or_skip!();
    w.set(|st| {
        st.linked.insert(
            OTHER.to_owned(),
            Some(Linked::Usable(vec![OWNER.to_owned()])),
        );
        st.grant.as_mut().unwrap().spend_limit_wei = ETH * 15 / 100;
    });
    let door = w.door(Over::default());
    let (me, other) = (as_(&door, USER), as_(&door, OTHER));
    me.bind(&bound()).unwrap();
    other.bind(&bound()).unwrap();
    order_of(&me.ask(SESSION, "a", TRADE));
    assert_eq!(
        message(&other.ask(OTHER_SESSION, "b", TRADE)),
        "agents.navigator_trade_over_cap"
    );
    assert_eq!(w.sent(), 1);
}

#[test]
fn an_ask_that_names_no_trade_stores_nothing_and_a_question_about_trading_goes_to_the_ordinary_run()
{
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    let none = Json::obj([("kind", Json::str("none"))]);
    assert_eq!(me.ask(SESSION, "q", "what moved today?").unwrap(), none);
    assert_eq!(
        me.ask(SESSION, "q2", "Where do I place a limit order?")
            .unwrap(),
        none
    );
    assert_eq!(w.count("navigator_orders", USER), 0);
}

#[test]
fn while_the_owner_froze_their_own_account_a_binding_and_a_trade_refuse_and_unreadable_refuses_too()
{
    let w = world_or_skip!();
    let door = w.door(Over::default());
    as_(&door, USER).bind(&bound()).unwrap();
    let frozen = |st: &mut State| {
        st.frozen
            .insert(USER.to_owned(), "2026-11-18T01:00:00.000Z".to_owned());
        st.freeze_down = false;
    };
    let down = |st: &mut State| {
        st.frozen.clear();
        st.freeze_down = true;
    };
    type Setup<'a> = &'a dyn Fn(&mut State);
    let cases: [(Setup<'_>, bool, &str); 3] = [
        (&frozen, false, "agents.identity.owner_frozen_self"),
        (&down, false, "agents.identity.owner_freeze_unread"),
        (
            &|_: &mut State| {},
            true,
            "agents.identity.owner_freeze_unread",
        ),
    ];
    for (setup, no_freeze, code) in cases {
        w.set(|st| setup(st));
        let d = w.door(Over {
            no_freeze,
            ..Over::default()
        });
        let me = as_(&d, USER);
        refused(
            &me.bind(&with(&grant(), "specHash", Json::str(hash_b()))),
            "FORBIDDEN",
            code,
        );
        refused(&me.ask(SESSION, "r-frozen", TRADE), "FORBIDDEN", code);
    }
    // Nothing was signed, sent or stored, and the binding is the one made before.
    assert_eq!(w.sent(), 0);
    assert_eq!(w.count("navigator_orders", USER), 0);
    w.set(|st| st.freeze_down = false);
    let read = as_(&door, USER).binding(ACCOUNT).unwrap();
    assert_eq!(s(read.get("binding").unwrap(), "specHash"), hash_a());
    // A revoke only narrows, so it still goes through while frozen.
    w.set(frozen);
    let revoked = as_(&door, USER).revoke().unwrap();
    assert!(matches!(
        revoked.get("revokeRequestedAt"),
        Some(Json::String(_))
    ));
}

#[test]
fn another_persons_session_another_agents_and_a_closed_one_are_refused() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    assert_eq!(
        me.ask(OTHER_SESSION, "r-6", TRADE).unwrap_err().0,
        "NOT_FOUND"
    );
    assert_eq!(
        me.ask(SCANNER_SESSION, "r-6", TRADE).unwrap_err().0,
        "NOT_FOUND"
    );
    assert_eq!(
        message(&me.ask(CLOSED_SESSION, "r-6", TRADE)),
        "agents.refused.session_closed"
    );
    assert_eq!(me.orders(OTHER_SESSION).unwrap_err().0, "NOT_FOUND");
    assert_eq!(w.sent(), 0);
}

#[test]
fn the_sessions_orders_are_listed_newest_first_survive_a_new_reader_and_show_no_other_persons() {
    let w = world_or_skip!();
    let door = w.door(Over::default());
    let me = as_(&door, USER);
    me.bind(&bound()).unwrap();
    order_of(&me.ask(SESSION, "r-1", TRADE));
    order_of(&me.ask(SESSION, "r-2", "TEST: swap 0.2 TESTWETH for TESTB"));
    let listed = me.orders(SESSION).unwrap();
    let Some(Json::Array(orders)) = listed.get("orders") else {
        panic!("no orders")
    };
    let texts: Vec<String> = orders.iter().map(|o| s(o, "text")).collect();
    assert_eq!(texts, ["TEST: swap 0.2 TESTWETH for TESTB", TRADE]);
    assert!(orders.iter().all(|o| s(o, "placedBy") == "assistant"));
    let store = db::open(&w.db.url, "svc-agents", 1, false).unwrap();
    let again: Vec<String> = store::orders(store.pool().unwrap(), USER, SESSION)
        .unwrap()
        .into_iter()
        .map(|o| o.id)
        .collect();
    assert_eq!(again, orders.iter().map(|o| s(o, "id")).collect::<Vec<_>>());
    let theirs = as_(&door, OTHER).orders(OTHER_SESSION).unwrap();
    assert_eq!(theirs.get("orders"), Some(&Json::Array(vec![])));
}
