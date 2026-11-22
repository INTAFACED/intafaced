//! The own-sharing slice through the door, on a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a
//! server whose admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's
//! own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/own/`: the "own agent identity" block of `identity.test.ts`; the
//! "account access" block of `access.test.ts` (its `own.policy.*` halves are the own-controls slice's: the access gate
//! they meet is asked here directly, `access::assert_allows`; the svc-trade and trade-draft cases are own-controls' and
//! own-runs'); the "own agent sharing" block of `publishing.test.ts`; the sharing cases of `memory.test.ts`; and
//! `self-freeze.test.ts` #1 and #4 with this slice's calls of #2 (the other slices' rows are written in SQL, and their
//! refusals while frozen are theirs to port).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::db::Store;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{MockOptions, MockProvider, Provider};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing;
use svc_agents::own::Own;
use svc_agents::own::access;
use svc_agents::own::desk::{CommentInput, DeskAccount, DeskComment, DeskSearch, SupportDesk};
use svc_agents::own::freeze_applied::{Applied, on_self_freeze_applied};
use svc_agents::self_freeze::{
    OWNER_FREEZE_UNREAD, OWNER_FROZEN_SELF, Reading, SelfFreezeRead, Unavailable,
};

const SECRET: &str = "an-agents-own-sharing-test-secret-of-32-plus-chars";
const SERVICE_SECRET: &str = "an-agents-own-sharing-service-secret-long";
const USER: &str = "a1111111-1111-4111-8111-111111111111";
const OTHER: &str = "b2222222-2222-4222-8222-222222222222";
const FROZEN: &str = "c3333333-3333-4333-8333-333333333333";
const VENUE_OWNER: &str = "0x1111111111111111111111111111111111111111";
const SUB_A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUB_B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FREEZE_ID: &str = "f0f0f0f0-0000-4000-8000-000000000001";
const SINCE: &str = "2026-11-17T10:00:00.000Z";

/// `createFixtureSupportDesk({ accounts })`: identity's projection of each account named, the rest unread.
struct Accounts(Vec<(&'static str, &'static str)>);

impl SupportDesk for Accounts {
    fn search_kb(&self, _: &str, _: Option<i64>) -> DeskSearch {
        DeskSearch::Ok(Vec::new())
    }
    fn read_account(&self, user_id: &str) -> DeskAccount {
        self.0
            .iter()
            .find(|(u, _)| *u == user_id)
            .map_or(DeskAccount::Unread, |(u, status)| DeskAccount::Ok {
                user_id: (*u).to_owned(),
                status: (*status).to_owned(),
                kyc_tier: "full".to_owned(),
            })
    }
    fn comment_ticket(&self, _: &CommentInput, _: &[(String, String)]) -> DeskComment {
        DeskComment::Unreachable
    }
}

fn active() -> Accounts {
    Accounts(vec![
        (USER, "active"),
        (OTHER, "active"),
        (FROZEN, "frozen"),
    ])
}

/// `MemorySelfFreezeRead`: the people frozen, and identity that can be taken down.
#[derive(Default)]
struct Freeze {
    frozen: Vec<&'static str>,
    down: bool,
}

impl SelfFreezeRead for Freeze {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable> {
        if self.down {
            return Err(Unavailable("TEST: identity down".to_owned()));
        }
        Ok(if self.frozen.contains(&user_id) {
            Reading::Frozen {
                since: Some(SINCE.to_owned()),
            }
        } else {
            Reading::Open
        })
    }
}

struct Build {
    accounts: Option<Accounts>,
    freeze: Option<Freeze>,
    lifetime: Option<i64>,
    now: fn() -> Instant,
}

impl Default for Build {
    fn default() -> Build {
        Build {
            accounts: Some(active()),
            freeze: Some(Freeze::default()),
            lifetime: Some(60),
            now: system_now,
        }
    }
}

fn door(db: &TestDb, b: Build) -> AgentsDoor {
    let mock: Arc<dyn Provider> = Arc::new(MockProvider::new(
        MockOptions {
            id: Some("primary".to_owned()),
            ..MockOptions::default()
        },
        system_now,
    ));
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
    own.support_desk = b.accounts.map(|a| Box::new(a) as Box<dyn SupportDesk>);
    own.token_lifetime_minutes = b.lifetime;
    let mut runtime = svc_agents::runtime::Runtime::unwired();
    runtime.self_freeze = b.freeze.map(|f| Box::new(f) as Box<dyn SelfFreezeRead>);
    AgentsDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(SERVICE_SECRET.to_owned()),
            keys: None,
        },
        env,
        now: b.now,
        store: db.store(),
        gateway: GatewaySlice {
            gateway: Arc::new(Gateway::new(
                vec![mock],
                routing::unpriced(&routing::default_table()),
            )),
            fee_asset_id: "IFC".to_owned(),
            metering_enabled: Some(false),
            window_minutes: 60,
        },
        ready: ReadyInput::unwired(),
        metering: svc_agents::metering::Metering::unwired("IFC", 60),
        runtime,
        advisors: svc_agents::advisors::Advisors::unwired(),
        background: svc_agents::background::Settings::default(),
        own,
        team: svc_agents::team::Team::unwired(),
        ops: svc_agents::ops::Ops::unwired(),
    })
    .unwrap()
}

fn fresh() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

/// `callerFor(userId, scopes)`: a signed principal.
fn caller(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("55555555-5555-4555-8555-555555555555")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ];
    let raw = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn person(user: &str) -> Vec<(String, String)> {
    caller(user, &["agents:read", "identity:write"])
}

fn query(door: &AgentsDoor, path: &str, input: &Json, headers: &[(String, String)]) -> (u16, Json) {
    let enc: String = input
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
    let url = format!("/trpc/{path}?input={enc}");
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(
    door: &AgentsDoor,
    path: &str,
    input: &Json,
    headers: &[(String, String)],
) -> (u16, Json) {
    let body = input.compact();
    let mut headers = headers.to_vec();
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let url = format!("/trpc/{path}");
    let res = door.handle(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: &body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

/// `rejects.toMatchObject({ code, message })`.
fn refused(answer: &(u16, Json)) -> (String, String) {
    assert_ne!(answer.0, 200, "not refused: {}", answer.1.compact());
    let e = answer.1.get("error").unwrap();
    let s = |j: Option<&Json>| match j {
        Some(Json::String(v)) => v.clone(),
        _ => String::new(),
    };
    (
        s(e.get("data").and_then(|d| d.get("code"))),
        s(e.get("message")),
    )
}

fn message(answer: &(u16, Json)) -> String {
    refused(answer).1
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(x)) => x.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn items(v: &Json) -> Vec<Json> {
    match v {
        Json::Array(items) => items.clone(),
        other => panic!("not a list: {other:?}"),
    }
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn by_id(id: &str) -> Json {
    obj(&[("id", Json::str(id))])
}

fn iso_ms(text: &str) -> i64 {
    service_kit::time::js_date(text).unwrap().0
}

/// `person.own.create({ template: 'service-starter', ... })`: the agent's id and its tools.
fn starter(d: &AgentsDoor, who: &[(String, String)], key: &str) -> (String, Json) {
    let agent = data(&mutate(
        d,
        "own.create",
        &obj(&[
            ("template", Json::str("service-starter")),
            ("createKey", Json::str(key)),
        ]),
        who,
    ));
    (s(&agent, "id"), agent.get("tools").cloned().unwrap())
}

fn pool(db: &TestDb) -> service_kit::pg::Pool {
    match db.store() {
        Store::Pool(p) => p,
        Store::Down(m) => panic!("{m}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// own agent identity (identity.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_blank_lifetime_issues_nothing() {
    let Some(db) = fresh() else { return };
    let d = door(
        &db,
        Build {
            lifetime: None,
            ..Build::default()
        },
    );
    let me = person(USER);
    let (id, _) = starter(&d, &me, "identity:blank");
    assert_eq!(
        message(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
        "agents.identity.lifetime_unset"
    );
    assert_eq!(
        data(&query(&d, "own.identity.get", &by_id(&id), &me)),
        obj(&[("token", Json::Null)])
    );
    assert_eq!(db.count("SELECT count(*) FROM agents.own_agent_tokens"), 0);
}

#[test]
fn issues_the_agent_its_own_token_its_owner_its_tools_as_scopes_its_expiry_the_call_answers_who_it_acts_as()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, tools) = starter(&d, &me, "identity:issue");
    let issued = data(&mutate(&d, "own.identity.issue", &by_id(&id), &me));
    let secret = s(&issued, "secret");
    assert!(secret.starts_with("agt_") && secret.len() == 47, "{secret}");
    assert!(
        secret[4..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    );
    let token = issued.get("token").cloned().unwrap();
    assert_eq!(s(&token, "agentId"), id);
    assert_eq!(s(&token, "ownerId"), USER);
    assert_eq!(token.get("scopes"), Some(&tools));
    assert_eq!(token.get("revokedAt"), Some(&Json::Null));
    assert_eq!(s(&token, "state"), "active");
    assert_eq!(
        iso_ms(&s(&token, "expiresAt")) - iso_ms(&s(&token, "issuedAt")),
        60 * 60_000
    );
    assert_eq!(
        data(&query(&d, "own.identity.get", &by_id(&id), &me)),
        obj(&[("token", token.clone())])
    );
    // Only the hash is kept.
    let stored: String = db
        .client()
        .query_one("SELECT token_hash FROM agents.own_agent_tokens", &[])
        .unwrap()
        .get(0);
    assert!(!stored.contains(&secret));
    assert_eq!(
        data(&mutate(
            &d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret.clone()))]),
            &[]
        )),
        obj(&[
            ("agentId", Json::str(id.clone())),
            ("ownerId", Json::str(USER)),
            ("scopes", tools),
            ("expiresAt", token.get("expiresAt").cloned().unwrap()),
        ])
    );
}

#[test]
fn a_revoke_makes_the_next_call_fail_so_does_a_token_issued_over_and_an_unknown_one() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "identity:revoke");
    let call = |secret: &str| {
        mutate(
            &d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret))]),
            &[],
        )
    };
    let first = s(
        &data(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
        "secret",
    );
    let second = s(
        &data(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
        "secret",
    );
    assert_eq!(
        refused(&call(&first)),
        (
            "UNAUTHORIZED".to_owned(),
            "agents.identity.token_revoked".to_owned()
        )
    );
    assert_eq!(s(&data(&call(&second)), "agentId"), id);
    let revoked = data(&mutate(&d, "own.identity.revoke", &by_id(&id), &me));
    assert_eq!(s(&revoked, "state"), "revoked");
    assert_eq!(
        refused(&call(&second)),
        (
            "UNAUTHORIZED".to_owned(),
            "agents.identity.token_revoked".to_owned()
        )
    );
    assert_eq!(
        message(&mutate(&d, "own.identity.revoke", &by_id(&id), &me)),
        "agents.identity.no_live_token"
    );
    assert_eq!(
        message(&call("agt_unknown")),
        "agents.identity.token_unknown"
    );
    assert_eq!(
        message(&call("not-an-agent-token")),
        "agents.identity.token_unknown"
    );
}

#[test]
fn a_frozen_closed_or_unread_owner_makes_the_token_fail() {
    let Some(db) = fresh() else { return };
    let issuer = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&issuer, &me, "identity:owner");
    let secret = s(
        &data(&mutate(&issuer, "own.identity.issue", &by_id(&id), &me)),
        "secret",
    );
    let call = |d: &AgentsDoor| {
        mutate(
            d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret.clone()))]),
            &[],
        )
    };
    let owner_reads = |accounts: Vec<(&'static str, &'static str)>| {
        door(
            &db,
            Build {
                accounts: Some(Accounts(accounts)),
                ..Build::default()
            },
        )
    };
    for (status, code) in [
        ("frozen", "agents.identity.owner_frozen"),
        ("closed", "agents.identity.owner_inactive"),
    ] {
        assert_eq!(
            refused(&call(&owner_reads(vec![(USER, status)]))),
            ("FORBIDDEN".to_owned(), code.to_owned())
        );
    }
    assert_eq!(
        refused(&call(&owner_reads(vec![]))),
        (
            "FORBIDDEN".to_owned(),
            "agents.identity.owner_unread".to_owned()
        )
    );
    // No desk wired at all reads unread too.
    let unwired = door(
        &db,
        Build {
            accounts: None,
            ..Build::default()
        },
    );
    assert_eq!(
        refused(&call(&unwired)),
        (
            "FORBIDDEN".to_owned(),
            "agents.identity.owner_unread".to_owned()
        )
    );
    // Nor can a frozen, closed or unread owner issue a new one; the token already issued stays the latest, unrevoked.
    let before = data(&query(&issuer, "own.identity.get", &by_id(&id), &me));
    for (accounts, code) in [
        (vec![(USER, "frozen")], "agents.identity.owner_frozen"),
        (vec![(USER, "closed")], "agents.identity.owner_inactive"),
        (vec![], "agents.identity.owner_unread"),
    ] {
        assert_eq!(
            refused(&mutate(
                &owner_reads(accounts),
                "own.identity.issue",
                &by_id(&id),
                &me
            )),
            ("FORBIDDEN".to_owned(), code.to_owned())
        );
    }
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM agents.own_agent_tokens WHERE agent_id = '{id}'"
        )),
        1
    );
    assert_eq!(
        data(&query(&issuer, "own.identity.get", &by_id(&id), &me)),
        before
    );
    let token = before.get("token").unwrap();
    assert_eq!(s(token, "state"), "active");
    assert_eq!(token.get("revokedAt"), Some(&Json::Null));
    assert_eq!(s(&data(&call(&issuer)), "agentId"), id);
}

fn issued_at() -> Instant {
    Instant(iso_ms("2026-11-04T10:00:00.000Z"))
}
fn a_minute_later() -> Instant {
    Instant(issued_at().0 + 60_000)
}

#[test]
fn an_expired_token_fails_its_next_call() {
    let Some(db) = fresh() else { return };
    let me = person(USER);
    let at_issue = door(
        &db,
        Build {
            lifetime: Some(1),
            now: issued_at,
            ..Build::default()
        },
    );
    let (id, _) = starter(&at_issue, &me, "identity:expiry");
    let secret = s(
        &data(&mutate(&at_issue, "own.identity.issue", &by_id(&id), &me)),
        "secret",
    );
    let later = door(
        &db,
        Build {
            accounts: None,
            freeze: None,
            now: a_minute_later,
            ..Build::default()
        },
    );
    assert_eq!(
        refused(&mutate(
            &later,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret))]),
            &[]
        )),
        (
            "UNAUTHORIZED".to_owned(),
            "agents.identity.token_expired".to_owned()
        )
    );
    let latest = data(&query(&later, "own.identity.get", &by_id(&id), &me));
    assert_eq!(s(latest.get("token").unwrap(), "state"), "expired");
}

#[test]
fn another_person_can_neither_read_issue_nor_revoke_the_agents_token() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let (me, them) = (person(USER), person(OTHER));
    let (id, _) = starter(&d, &me, "identity:other");
    data(&mutate(&d, "own.identity.issue", &by_id(&id), &me));
    assert_eq!(
        message(&query(&d, "own.identity.get", &by_id(&id), &them)),
        "agents.own.not_found"
    );
    for path in ["own.identity.issue", "own.identity.revoke"] {
        assert_eq!(
            refused(&mutate(&d, path, &by_id(&id), &them)),
            ("NOT_FOUND".to_owned(), "agents.own.not_found".to_owned())
        );
    }
    let token = data(&query(&d, "own.identity.get", &by_id(&id), &me));
    assert_eq!(s(token.get("token").unwrap(), "state"), "active");
}

#[test]
fn deleting_the_draft_deletes_its_tokens() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "identity:delete");
    let secret = s(
        &data(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
        "secret",
    );
    data(&mutate(
        &d,
        "own.delete",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("confirm", Json::str("delete for good")),
        ]),
        &me,
    ));
    assert_eq!(db.count("SELECT count(*) FROM agents.own_agent_tokens"), 0);
    assert_eq!(
        message(&mutate(
            &d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret))]),
            &[]
        )),
        "agents.identity.token_unknown"
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// account access (access.test.ts, J-agents-08 #2)
// ---------------------------------------------------------------------------------------------------------------------

fn grant_of(id: &str, subs: &[&str], ends_in_days: Option<&str>, grant_key: &str) -> Json {
    obj(&[
        ("id", Json::str(id)),
        ("grantKey", Json::str(grant_key)),
        ("venueId", Json::str("test-venue")),
        ("owner", Json::str(VENUE_OWNER)),
        (
            "subAccounts",
            Json::Array(
                subs.iter()
                    .map(|sub| {
                        obj(&[
                            ("subAccount", Json::str(*sub)),
                            (
                                "name",
                                Json::str(if *sub == SUB_A {
                                    "Sub-account A"
                                } else {
                                    "Sub-account B"
                                }),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("endsInDays", ends_in_days.map_or(Json::Null, Json::str)),
    ])
}

fn key(n: u32) -> String {
    format!("0000000{n}-0000-4000-8000-000000000000")
}

fn grants(d: &AgentsDoor, who: &[(String, String)], id: &str) -> Vec<Json> {
    items(
        data(&query(d, "own.access.get", &by_id(id), who))
            .get("grants")
            .unwrap(),
    )
}

/// The gate an action naming `account` meets before the rules (`own.policy.check`'s first step, own-controls').
fn gate(db: &TestDb, id: &str, account: &str) -> Option<String> {
    access::assert_allows(&pool(db), USER, id, account, system_now())
        .err()
        .map(|e| match e {
            svc_agents::own::OwnError::Refusal(r) => r.code,
            other => panic!("{other:?}"),
        })
}

#[test]
fn access_to_sub_account_a_only_a_tool_naming_b_is_refused_one_naming_a_passes_to_the_rules_a_blank_end_grants_nothing()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "access:a-only");
    for blank in [None, Some("")] {
        assert_eq!(
            message(&mutate(
                &d,
                "own.access.grant",
                &grant_of(&id, &[SUB_A], blank, &key(1)),
                &me
            )),
            "agents.access_expiry_unset"
        );
    }
    assert!(grants(&d, &me, &id).is_empty());
    let before = system_now().0;
    let granted = items(
        data(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &[SUB_A], Some("7"), &key(2)),
            &me,
        ))
        .get("grants")
        .unwrap(),
    );
    assert_eq!(granted.len(), 1);
    let g = &granted[0];
    assert_eq!(
        [
            s(g, "subAccount"),
            s(g, "name"),
            s(g, "owner"),
            s(g, "venueId")
        ],
        [SUB_A, "Sub-account A", VENUE_OWNER, "test-venue"].map(str::to_owned)
    );
    assert_eq!(
        iso_ms(&s(g, "endsAt")) - iso_ms(&s(g, "grantedAt")),
        7 * 86_400_000
    );
    assert!(iso_ms(&s(g, "grantedAt")) >= before - 1000);
    assert_eq!(
        gate(&db, &id, &format!("sub:{SUB_B}")).as_deref(),
        Some("agents.access_account_denied")
    );
    assert_eq!(gate(&db, &id, &format!("sub:{SUB_A}")), None);
    assert_eq!(gate(&db, &id, "main"), None);
}

#[test]
fn access_past_its_end_is_refused_agents_access_expired_a_new_grant_replaces_the_old_one_exactly() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "access:expired");
    data(&mutate(
        &d,
        "own.access.grant",
        &grant_of(&id, &[SUB_A, SUB_B], Some("7"), &key(1)),
        &me,
    ));
    db.client()
        .execute(
            "UPDATE agents.own_agent_account_access SET granted_at = now() - interval '8 days', ends_at = now() - interval '1 day'",
            &[],
        )
        .unwrap();
    assert_eq!(
        gate(&db, &id, &format!("sub:{SUB_A}")).as_deref(),
        Some("agents.access_expired")
    );
    let granted = items(
        data(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &[SUB_A], Some("1"), &key(2)),
            &me,
        ))
        .get("grants")
        .unwrap(),
    );
    assert_eq!(
        granted
            .iter()
            .map(|g| s(g, "subAccount"))
            .collect::<Vec<_>>(),
        [SUB_A]
    );
    assert_eq!(gate(&db, &id, &format!("sub:{SUB_A}")), None);
    assert_eq!(
        gate(&db, &id, &format!("sub:{SUB_B}")).as_deref(),
        Some("agents.access_account_denied")
    );
    assert_eq!(
        db.count("SELECT count(*) FROM agents.own_agent_account_access WHERE ended_at IS NULL"),
        1
    );
}

#[test]
fn a_retried_grant_is_the_same_grant_it_ends_nothing_and_adds_nothing_two_grants_at_once_leave_one_set_live()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "access:retry");
    let first = data(&mutate(
        &d,
        "own.access.grant",
        &grant_of(&id, &[SUB_A], Some("7"), &key(1)),
        &me,
    ));
    let again = data(&mutate(
        &d,
        "own.access.grant",
        &grant_of(&id, &[SUB_A], Some("7"), &key(1)),
        &me,
    ));
    assert_eq!(again, first);
    assert_eq!(
        db.count("SELECT count(*) FROM agents.own_agent_account_access"),
        1
    );
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            mutate(
                &d,
                "own.access.grant",
                &grant_of(&id, &[SUB_A], Some("3"), &key(2)),
                &me,
            )
        });
        let b = scope.spawn(|| {
            mutate(
                &d,
                "own.access.grant",
                &grant_of(&id, &[SUB_B], Some("3"), &key(3)),
                &me,
            )
        });
        data(&a.join().unwrap());
        data(&b.join().unwrap());
    });
    assert_eq!(grants(&d, &me, &id).len(), 1);
}

#[test]
fn an_empty_or_malformed_grant_is_refused_and_grants_nothing() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "access:malformed");
    assert_eq!(
        message(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &[], Some("7"), &key(1)),
            &me
        )),
        "agents.access_none_chosen"
    );
    assert_eq!(
        message(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &["0xnot"], Some("7"), &key(2)),
            &me
        )),
        "agents.access_request_invalid"
    );
    let mut nobody = grant_of(&id, &[SUB_A], Some("7"), &key(3));
    if let Json::Object(fields) = &mut nobody {
        for (k, v) in fields.iter_mut() {
            if k == "owner" {
                *v = Json::str("nobody");
            }
        }
    }
    assert_eq!(
        message(&mutate(&d, "own.access.grant", &nobody, &me)),
        "agents.access_request_invalid"
    );
    // The same sub-account named twice is malformed too.
    assert_eq!(
        message(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &[SUB_A, SUB_A], Some("7"), &key(4)),
            &me
        )),
        "agents.access_request_invalid"
    );
    assert!(grants(&d, &me, &id).is_empty());
}

#[test]
fn only_the_person_grants_access_another_person_reaches_no_agent_and_a_token_that_is_not_their_session_is_refused()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let (me, them) = (person(USER), person(OTHER));
    let not_session = caller(USER, &["agents:read", "agents:execute"]);
    let (id, _) = starter(&d, &me, "access:person");
    assert_eq!(
        message(&mutate(
            &d,
            "own.access.grant",
            &grant_of(&id, &[SUB_A], Some("7"), &key(1)),
            &them
        )),
        "agents.own.not_found"
    );
    refused(&mutate(
        &d,
        "own.access.grant",
        &grant_of(&id, &[SUB_A], Some("7"), &key(2)),
        &not_session,
    ));
    assert_eq!(
        message(&query(&d, "own.access.get", &by_id(&id), &them)),
        "agents.own.not_found"
    );
    assert!(grants(&d, &me, &id).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// own agent sharing (publishing.test.ts) and privacy and sharing (memory.test.ts, J-agents-09 #6)
// ---------------------------------------------------------------------------------------------------------------------

fn helper(d: &AgentsDoor, who: &[(String, String)], key: &str) -> String {
    let (id, _) = starter(d, who, key);
    data(&mutate(
        d,
        "own.save",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("name", Json::str("TEST helper")),
            ("instructions", Json::str("")),
            ("tools", Json::Array(Vec::new())),
            ("perSessionCap", Json::str("1")),
        ]),
        who,
    ));
    id
}

fn co_owner(id: &str, who: &str) -> Json {
    obj(&[("id", Json::str(id)), ("coOwner", Json::str(who))])
}

fn shared_with(d: &AgentsDoor, who: &[(String, String)]) -> Json {
    data(&query(
        d,
        "own.sharedWithMe",
        &obj(&[("limit", Json::int(10))]),
        who,
    ))
}

#[test]
fn adds_one_active_person_as_co_owner_once_a_group_the_owner_a_frozen_or_unread_account_is_refused()
{
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let (me, them) = (person(USER), person(OTHER));
    let id = helper(&d, &me, "sharing:co-owner");
    let add = |who: &str, by: &[(String, String)]| {
        mutate(&d, "own.coOwners.add", &co_owner(&id, who), by)
    };
    assert_eq!(
        message(&add("group:TEST-team", &me)),
        "agents.own.co_owner_group"
    );
    assert_eq!(message(&add(USER, &me)), "agents.own.co_owner_self");
    assert_eq!(message(&add(FROZEN, &me)), "agents.own.co_owner_inactive");
    assert_eq!(
        message(&add("44444444-4444-4444-8444-444444444444", &me)),
        "agents.own.co_owner_unread"
    );
    // A business named by its bare id is a group too.
    let business = "55555555-5555-4555-8555-555555555555";
    db.client()
        .execute(
            "INSERT INTO agents.team_pools (business_id, asset_id, pool_limit, version, idempotency_key, digest, set_by)
             VALUES ($1::text::uuid, 'USDT', 1, 1, 'publish-test:business', 'TEST', $2::text)",
            &[&business, &USER],
        )
        .unwrap();
    assert_eq!(message(&add(business, &me)), "agents.own.co_owner_group");
    db.client()
        .execute("DELETE FROM agents.team_pools", &[])
        .unwrap();
    assert_eq!(
        data(&query(&d, "own.coOwners.list", &by_id(&id), &me)),
        Json::Array(Vec::new())
    );
    let added = items(&data(&add(OTHER, &me)));
    assert_eq!(
        added.iter().map(|r| s(r, "userId")).collect::<Vec<_>>(),
        [OTHER]
    );
    let again = items(&data(&add(OTHER, &me)));
    assert_eq!(
        again.iter().map(|r| s(r, "userId")).collect::<Vec<_>>(),
        [OTHER]
    );
    assert_eq!(
        shared_with(&d, &them),
        Json::Array(vec![obj(&[
            ("id", Json::str(id.clone())),
            ("ownerId", Json::str(USER)),
            ("name", Json::str("TEST helper")),
            ("version", Json::int(1)),
            ("state", Json::str("draft")),
        ])])
    );
    // A co-owner cannot add co-owners to an agent that is not theirs.
    assert_eq!(refused(&add(FROZEN, &them)).0, "NOT_FOUND");
    data(&mutate(
        &d,
        "own.coOwners.remove",
        &co_owner(&id, OTHER),
        &me,
    ));
    assert_eq!(shared_with(&d, &them), Json::Array(Vec::new()));
}

fn share_input(id: &str, transcripts: bool, memory: bool, confirmed: Option<bool>) -> Json {
    let mut fields = vec![
        ("id", Json::str(id)),
        ("includeTranscripts", Json::Bool(transcripts)),
        ("includeMemory", Json::Bool(memory)),
    ];
    if let Some(c) = confirmed {
        fields.push(("confirmed", Json::Bool(c)));
    }
    obj(&fields)
}

#[test]
fn a_share_that_exposes_a_transcript_is_listed_by_the_check_and_refused_until_confirmed_nothing_is_shared_before()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "share:confirm");
    assert_eq!(
        data(&query(
            &d,
            "own.share.check",
            &share_input(&id, true, false, None),
            &me
        )),
        obj(&[
            ("exposes", Json::Array(vec![Json::str("transcripts")])),
            ("coOwners", Json::int(0)),
        ])
    );
    db.client()
        .execute(
            "INSERT INTO agents.own_agent_co_owners (agent_id, owner_id, co_owner_id) VALUES ($1::text::uuid, $2::text, $3::text)",
            &[&id, &USER, &OTHER],
        )
        .unwrap();
    assert_eq!(
        refused(&mutate(
            &d,
            "own.share.set",
            &share_input(&id, true, false, Some(false)),
            &me
        )),
        (
            "PRECONDITION_FAILED".to_owned(),
            "agents.privacy.confirm_required".to_owned()
        )
    );
    assert_eq!(
        data(&query(&d, "own.share.get", &by_id(&id), &me)),
        obj(&[
            ("shared", Json::Bool(false)),
            ("includeTranscripts", Json::Bool(false)),
            ("includeMemory", Json::Bool(false)),
            ("sharedAt", Json::Null),
        ])
    );
    let shared = data(&mutate(
        &d,
        "own.share.set",
        &share_input(&id, true, false, Some(true)),
        &me,
    ));
    assert_eq!(shared.get("shared"), Some(&Json::Bool(true)));
    assert_eq!(shared.get("includeTranscripts"), Some(&Json::Bool(true)));
    assert_eq!(shared.get("includeMemory"), Some(&Json::Bool(false)));
    assert_eq!(data(&query(&d, "own.share.get", &by_id(&id), &me)), shared);
}

#[test]
fn an_agent_with_no_co_owner_has_no_one_to_share_with() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let (id, _) = starter(&d, &me, "share:none");
    assert_eq!(
        message(&mutate(
            &d,
            "own.share.set",
            &share_input(&id, false, false, Some(true)),
            &me
        )),
        "agents.share.no_co_owners"
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// the owner's own freeze (self-freeze.test.ts, J-wallet-13)
// ---------------------------------------------------------------------------------------------------------------------

struct Equipped {
    id: String,
    secret: String,
}

/// `equip`: one agent of the person's with every permission svc-agents keeps, and one scheduled run of each kind.
/// This slice's are made through the door; the other slices' rows (consents, the Navigator's binding, schedules,
/// triggers and runs) are written as their calls would write them.
fn equip(db: &TestDb, d: &AgentsDoor, user: &str) -> Equipped {
    let who = person(user);
    let id = helper(d, &who, &format!("freeze:{user}"));
    data(&mutate(
        d,
        "own.access.grant",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("grantKey", Json::str(key(9))),
            ("venueId", Json::str("TEST-venue")),
            ("owner", Json::str(VENUE_OWNER)),
            (
                "subAccounts",
                Json::Array(vec![obj(&[
                    ("subAccount", Json::str(SUB_A)),
                    ("name", Json::str("TEST A")),
                ])]),
            ),
            ("endsInDays", Json::str("7")),
        ]),
        &who,
    ));
    let secret = s(
        &data(&mutate(d, "own.identity.issue", &by_id(&id), &who)),
        "secret",
    );
    let mut c = db.client();
    for class in ["own_data", "market_data"] {
        c.execute(
            "INSERT INTO agents.own_agent_consents (agent_id, owner_id, data_class, consent_key)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::text)",
            &[&id, &user, &class, &format!("consent:{id}:{class}")],
        )
        .unwrap();
    }
    let account = format!("0x{}", if user == USER { "d" } else { "e" }.repeat(40));
    c.execute(
        "INSERT INTO agents.navigator_onchain_bindings
           (user_id, chain_id, account, session_key, spend_limit_wei, valid_until, targets, selectors, spec_hash, bind_key)
         VALUES ($1::text, 84532, $2::text, $3::text, 1000, 4102444800, ARRAY[$4::text], ARRAY['0x12345678'], $5::text, $6::text)",
        &[
            &user,
            &account,
            &format!("0x{}", "f".repeat(40)),
            &format!("0x{}", "1".repeat(40)),
            &format!("0x{}", "2".repeat(64)),
            &format!("bind:{user}"),
        ],
    )
    .unwrap();
    let schedule: String = c
        .query_one(
            "INSERT INTO agents.own_agent_schedules (agent_id, owner_id, create_key, repeat, interval_minutes, per_run_cap, ask, next_due_at)
             VALUES ($1::text::uuid, $2::text, $3::text, 'repeat', 60, 0.1, 'TEST check', now() + interval '1 day')
             RETURNING id::text",
            &[&id, &user, &format!("sched:{user}")],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO agents.own_agent_triggers (agent_id, owner_id, create_key, subject, per_run_cap, ask)
         VALUES ($1::text::uuid, $2::text, $3::text, 'trade.fill.settled', 0.1, 'TEST on fill')",
        &[&id, &user, &format!("trig:{user}")],
    )
    .unwrap();
    // An occurrence a worker claimed and has not run yet.
    c.execute(
        "INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, ordinal, due_at)
         VALUES ($1::text, $2::text::uuid, $3::text, 'schedule', $4::text::uuid, 99, now())",
        &[&format!("agents:schedule:{schedule}:99"), &id, &user, &schedule],
    )
    .unwrap();
    // A session's background run that is going on, and a background test run of the agent.
    let session: String = c
        .query_one(
            "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
             VALUES ($1::text, 'navigator', '{\"limits\":{}}'::jsonb, 1) RETURNING id::text",
            &[&user],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO agents.session_background_runs (user_id, session_id, agent_id, request_key, task, ask, notice, steps_total, state)
         VALUES ($1::text, $2::text::uuid, 'navigator', $3::text, 'navigator.plan', 'TEST', 'inapp', 3, 'running')",
        &[&user, &session, &format!("bg:{user}")],
    )
    .unwrap();
    c.execute(
        "INSERT INTO agents.own_agent_background_runs (owner_id, agent_id, request_key, ask, steps_total)
         VALUES ($1::text, $2::text::uuid, $3::text, 'TEST', 3)",
        &[&user, &id, &format!("test:{user}")],
    )
    .unwrap();
    Equipped { id, secret }
}

/// `live`: what svc-agents keeps live for one person, each kind of permission and scheduled run, counted.
fn live(db: &TestDb, user: &str) -> [i64; 9] {
    let n = |sql: &str| -> i64 { db.client().query_one(sql, &[&user]).unwrap().get(0) };
    [
        n(
            "SELECT count(*) FROM agents.own_agent_tokens WHERE owner_id = $1::text AND revoked_at IS NULL",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_consents WHERE owner_id = $1::text AND revoked_at IS NULL",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_account_access WHERE owner_id = $1::text AND ended_at IS NULL",
        ),
        n(
            "SELECT count(*) FROM agents.navigator_onchain_bindings WHERE user_id = $1::text AND revoke_requested_at IS NULL",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_schedules WHERE owner_id = $1::text AND state = 'active'",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_triggers WHERE owner_id = $1::text AND state = 'active'",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_auto_runs WHERE owner_id = $1::text AND state = 'claimed'",
        ),
        n(
            "SELECT count(*) FROM agents.session_background_runs WHERE user_id = $1::text AND state IN ('queued', 'running')",
        ),
        n(
            "SELECT count(*) FROM agents.own_agent_background_runs WHERE owner_id = $1::text AND state = 'running'",
        ),
    ]
}

const ALL_LIVE: [i64; 9] = [1, 2, 1, 1, 1, 1, 1, 1, 1];
const NONE_LIVE: [i64; 9] = [0; 9];

fn payload() -> Json {
    obj(&[
        ("userId", Json::str(USER)),
        ("freezeId", Json::str(FREEZE_ID)),
        ("since", Json::str(SINCE)),
    ])
}

fn rows(db: &TestDb, sql: &str) -> Vec<Vec<Option<String>>> {
    db.client()
        .query(sql, &[])
        .unwrap()
        .iter()
        .map(|r| {
            (0..r.len())
                .map(|i| r.get::<_, Option<String>>(i))
                .collect()
        })
        .collect()
}

#[test]
fn the_freeze_event_revokes_and_stops_everything_of_the_persons_nothing_of_anothers_delivered_twice_it_is_one_change()
 {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let mine = equip(&db, &d, USER);
    let theirs = equip(&db, &d, OTHER);
    assert_eq!(live(&db, USER), ALL_LIVE);
    assert_eq!(live(&db, OTHER), ALL_LIVE);
    let p = pool(&db);
    let (applied, repeated) = on_self_freeze_applied(&p, &payload()).unwrap();
    assert!(!repeated);
    assert_eq!(live(&db, USER), NONE_LIVE);
    assert_eq!(live(&db, OTHER), ALL_LIVE);
    // The scheduled occurrence settled as skipped by the freeze; the test run stopped with the freeze's code.
    let user = format!("'{USER}'");
    assert_eq!(
        rows(
            &db,
            &format!(
                "SELECT state, code, reason_code FROM agents.own_agent_auto_runs WHERE owner_id = {user}"
            )
        ),
        [[
            Some("skipped".to_owned()),
            Some("agents.schedule_blocked".to_owned()),
            Some(OWNER_FROZEN_SELF.to_owned())
        ]]
    );
    assert_eq!(
        rows(
            &db,
            &format!(
                "SELECT state, stop_code FROM agents.own_agent_background_runs WHERE owner_id = {user}"
            )
        ),
        [[
            Some("stopped".to_owned()),
            Some(OWNER_FROZEN_SELF.to_owned())
        ]]
    );
    assert_eq!(
        rows(
            &db,
            &format!("SELECT state FROM agents.session_background_runs WHERE user_id = {user}")
        ),
        [[Some("paused".to_owned())]]
    );
    // The agent's token is revoked; the other person's still answers.
    let call = |secret: &str| {
        mutate(
            &d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret))]),
            &[],
        )
    };
    assert_eq!(
        message(&call(&mine.secret)),
        "agents.identity.token_revoked"
    );
    assert_eq!(s(&data(&call(&theirs.secret)), "ownerId"), OTHER);
    let record = || {
        rows(
            &db,
            &format!(
                "SELECT max(updated_at)::text FROM (
                   SELECT updated_at FROM agents.own_agent_tokens WHERE owner_id = {user}
                   UNION ALL SELECT updated_at FROM agents.own_agent_consents WHERE owner_id = {user}
                   UNION ALL SELECT updated_at FROM agents.navigator_onchain_bindings WHERE user_id = {user}
                   UNION ALL SELECT updated_at FROM agents.own_agent_schedules WHERE owner_id = {user}
                 ) t"
            ),
        )
    };
    let before = record();
    let expected = Applied {
        tokens_revoked: 1,
        consents_revoked: 2,
        account_access_ended: 1,
        onchain_bindings_revoking: 1,
        schedules_cancelled: 1,
        triggers_cancelled: 1,
        auto_runs_skipped: 1,
        session_runs_paused: 1,
        test_runs_stopped: 1,
    };
    assert_eq!(applied, expected);
    let stored = || {
        let r = db
            .client()
            .query_one("SELECT freeze_id::text, user_id, applied::text, since = $1::text::timestamptz FROM agents.self_freezes_applied", &[&SINCE])
            .unwrap();
        (
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            json::parse(&r.get::<_, String>(2)).unwrap(),
            r.get::<_, bool>(3),
        )
    };
    let first = stored();
    assert_eq!(
        (first.0.as_str(), first.1.as_str(), first.3),
        (FREEZE_ID, USER, true)
    );
    let keys: BTreeSet<String> = match &first.2 {
        Json::Object(fields) => fields.iter().map(|(k, _)| k.clone()).collect(),
        other => panic!("{other:?}"),
    };
    let want: BTreeSet<String> = match expected.to_json() {
        Json::Object(fields) => fields.into_iter().map(|(k, _)| k).collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(keys, want);
    // Delivered again, and again after a restart: the freeze's own record stands between it and a second change.
    for _ in 0..2 {
        let (again, repeated) = on_self_freeze_applied(&pool(&db), &payload()).unwrap();
        assert!(repeated);
        assert_eq!(again, expected);
    }
    assert_eq!(
        db.count("SELECT count(*) FROM agents.self_freezes_applied"),
        1
    );
    assert_eq!(stored(), first);
    assert_eq!(record(), before);
    assert_eq!(live(&db, OTHER), ALL_LIVE);
}

#[test]
fn after_the_lift_nothing_comes_back_by_itself_the_person_grants_each_permission_again() {
    let Some(db) = fresh() else { return };
    let d = door(&db, Build::default());
    let me = person(USER);
    let Equipped { id, .. } = equip(&db, &d, USER);
    on_self_freeze_applied(&pool(&db), &payload()).unwrap();
    // Lifted: identity reads open again (this door's reader). What the freeze revoked or stopped stays so.
    assert_eq!(live(&db, USER), NONE_LIVE);
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM agents.own_agent_consents WHERE agent_id = '{id}' AND revoked_at IS NULL"
        )),
        0
    );
    let latest = data(&query(&d, "own.identity.get", &by_id(&id), &me));
    assert_eq!(s(latest.get("token").unwrap(), "state"), "revoked");
    assert!(grants(&d, &me, &id).is_empty());
    // Granting again works, and only what the person grants is live.
    data(&mutate(&d, "own.identity.issue", &by_id(&id), &me));
    assert_eq!(live(&db, USER), [1, 0, 0, 0, 0, 0, 0, 0, 0]);
}

fn grant_a(id: &str) -> Json {
    obj(&[
        ("id", Json::str(id)),
        ("grantKey", Json::str(key(8))),
        ("venueId", Json::str("TEST-venue")),
        ("owner", Json::str(VENUE_OWNER)),
        (
            "subAccounts",
            Json::Array(vec![obj(&[
                ("subAccount", Json::str(SUB_A)),
                ("name", Json::str("TEST A")),
            ])]),
        ),
        ("endsInDays", Json::str("7")),
    ])
}

#[test]
fn while_frozen_a_new_key_the_agents_token_and_an_access_grant_are_each_refused_owner_frozen_self_and_nothing_changes()
 {
    let Some(db) = fresh() else { return };
    let setup = door(&db, Build::default());
    let Equipped { id, secret } = equip(&db, &setup, USER);
    let before = live(&db, USER);
    let d = door(
        &db,
        Build {
            freeze: Some(Freeze {
                frozen: vec![USER],
                down: false,
            }),
            ..Build::default()
        },
    );
    let (me, them) = (person(USER), person(OTHER));
    let frozen = ("FORBIDDEN".to_owned(), OWNER_FROZEN_SELF.to_owned());
    // A new key for the agent, and the agent's existing token used (even before the event reached svc-agents).
    assert_eq!(
        refused(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
        frozen
    );
    assert_eq!(
        refused(&mutate(
            &d,
            "own.identity.agentCall",
            &obj(&[("token", Json::str(secret))]),
            &[]
        )),
        frozen
    );
    // A permission change that gives the agent more.
    assert_eq!(
        refused(&mutate(&d, "own.access.grant", &grant_a(&id), &me)),
        frozen
    );
    // Nothing was granted or issued.
    assert_eq!(live(&db, USER), before);
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM agents.own_agent_tokens WHERE owner_id = '{USER}'"
        )),
        1
    );
    // Another person is not frozen by it.
    let (theirs, _) = starter(&d, &them, "freeze:other:fresh");
    data(&mutate(&d, "own.identity.issue", &by_id(&theirs), &them));
}

#[test]
fn fails_closed_identity_down_or_no_freeze_read_wired_refuses_every_one_owner_freeze_unread_and_changes_nothing()
 {
    let Some(db) = fresh() else { return };
    let setup = door(&db, Build::default());
    let Equipped { id, secret } = equip(&db, &setup, USER);
    let before = live(&db, USER);
    let me = person(USER);
    for freeze in [
        Some(Freeze {
            frozen: Vec::new(),
            down: true,
        }),
        None,
    ] {
        let d = door(
            &db,
            Build {
                freeze,
                ..Build::default()
            },
        );
        let unread = ("FORBIDDEN".to_owned(), OWNER_FREEZE_UNREAD.to_owned());
        assert_eq!(
            refused(&mutate(&d, "own.identity.issue", &by_id(&id), &me)),
            unread
        );
        assert_eq!(
            refused(&mutate(
                &d,
                "own.identity.agentCall",
                &obj(&[("token", Json::str(secret.clone()))]),
                &[]
            )),
            unread
        );
        assert_eq!(
            refused(&mutate(&d, "own.access.grant", &grant_a(&id), &me)),
            unread
        );
    }
    assert_eq!(live(&db, USER), before);
}
