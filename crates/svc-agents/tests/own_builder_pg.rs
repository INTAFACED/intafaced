//! The own-builder slice's drafts, assistant and rules through the door, on a real Postgres (`TEST_DATABASE_URL_AGENTS`
//! or `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in its own throwaway database
//! migrated by the crate's own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/own/store.test.ts` (every case), the "drafting with the
//! assistant" block of `own/identity.test.ts`, and the "standing rules" case of `own/guardrails.test.ts` (its session
//! is not opened here: `own.session.open` is the own-runs slice's, and the case's point is the rule itself).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{MockOptions, MockProvider, Provider};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing;
use svc_agents::own::Own;
use svc_agents::own::catalog::OWN_AGENTS_MAX;
use svc_agents::own::gates::parse_policy_baseline;

const SECRET: &str = "an-agents-own-agent-test-secret-of-32-plus-chars";
const SERVICE_SECRET: &str = "an-agents-own-builder-service-secret-long";
const USER: &str = "a1111111-1111-4111-8111-111111111111";
const OTHER: &str = "b2222222-2222-4222-8222-222222222222";
const DESCRIPTION: &str = "TEST: answer questions about my orders and never move money.";

fn door(db: &TestDb, own: Own) -> AgentsDoor {
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
    AgentsDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(SERVICE_SECRET.to_owned()),
            keys: None,
        },
        env,
        now: system_now,
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
        runtime: svc_agents::runtime::Runtime::unwired(),
        advisors: svc_agents::advisors::Advisors::unwired(),
        own,
    })
    .unwrap()
}

fn own_with(f: impl FnOnce(&mut Own)) -> Own {
    let mut own = Own::unwired();
    f(&mut own);
    own
}

/// `callerFor(userId, scopes, { kid })`: a signed principal.
fn caller(user: &str, scopes: &[&str], kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
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

fn person(user: &str) -> Vec<(String, String)> {
    caller(user, &["agents:read", "identity:write"], None)
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

fn query_none(door: &AgentsDoor, path: &str, headers: &[(String, String)]) -> (u16, Json) {
    let url = format!("/trpc/{path}");
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

/// The person's request with a service's signature on it too (`{ ...ctx, service }`).
fn with_service(
    mut headers: Vec<(String, String)>,
    path: &str,
    input: &Json,
    method: &str,
) -> Vec<(String, String)> {
    let body = if method == "POST" {
        input.compact()
    } else {
        String::new()
    };
    headers.extend(
        CallSigner::new("svc-support", "svc-agents", SERVICE_SECRET, None)
            .sign(&body, method, &format!("/trpc/{path}"), "application/json")
            .unwrap(),
    );
    headers
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

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(x)) => x.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn strings(v: &Json, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Json::Array(items)) => items
            .iter()
            .map(|i| match i {
                Json::String(x) => x.clone(),
                other => panic!("not a string: {other:?}"),
            })
            .collect(),
        other => panic!("{key} is not a list: {other:?}"),
    }
}

fn ids(v: &Json) -> Vec<String> {
    match v {
        Json::Array(items) => items.iter().map(|a| s(a, "id")).collect(),
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

fn create(door: &AgentsDoor, who: &[(String, String)], template: &str, key: &str) -> (u16, Json) {
    mutate(
        door,
        "own.create",
        &obj(&[
            ("template", Json::str(template)),
            ("createKey", Json::str(key)),
        ]),
        who,
    )
}

fn list(door: &AgentsDoor, who: &[(String, String)], limit: i64) -> (u16, Json) {
    query(door, "own.list", &obj(&[("limit", Json::int(limit))]), who)
}

fn get(door: &AgentsDoor, who: &[(String, String)], id: &str) -> (u16, Json) {
    query(door, "own.get", &obj(&[("id", Json::str(id))]), who)
}

fn save(
    door: &AgentsDoor,
    who: &[(String, String)],
    id: &str,
    name: &str,
    instructions: &str,
    tools: &[&str],
    cap: Option<&str>,
) -> (u16, Json) {
    mutate(
        door,
        "own.save",
        &obj(&[
            ("id", Json::str(id)),
            ("name", Json::str(name)),
            ("instructions", Json::str(instructions)),
            (
                "tools",
                Json::Array(tools.iter().map(|t| Json::str(*t)).collect()),
            ),
            ("perSessionCap", cap.map_or(Json::Null, Json::str)),
        ]),
        who,
    )
}

macro_rules! db_or_skip {
    () => {
        match TestDb::new() {
            Some(db) => {
                db.migrated();
                db
            }
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

const STARTER: [&str; 3] = [
    "support.kb.search",
    "support.ticket.read",
    "identity.account.read",
];

#[test]
fn with_only_blank_offered_the_catalogue_lists_blank_alone_and_a_create_from_the_starter_is_unknown()
 {
    let db = db_or_skip!();
    let d = door(&db, own_with(|o| o.templates = vec!["blank"]));
    let me = person(USER);
    assert_eq!(
        data(&query_none(&d, "own.catalogue", &me))
            .get("templates")
            .unwrap()
            .compact(),
        r#"[{"id":"blank","tools":[]}]"#
    );
    assert_eq!(
        refused(&create(&d, &me, "service-starter", "blank-only:starter")).1,
        "agents.own.template_unknown"
    );
    assert_eq!(data(&list(&d, &me, 10)), Json::Array(vec![]));
    assert!(
        strings(
            &data(&create(&d, &me, "blank", "blank-only:blank")),
            "tools"
        )
        .is_empty()
    );
}

#[test]
fn creates_a_draft_from_the_service_starter_with_its_tools_and_no_cap_a_retried_create_is_the_same_draft_a_new_one_the_next()
 {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let windows = || {
        db.count(&format!(
            "SELECT count(*) FROM agents.usage_windows w JOIN agents.agent_sessions s ON s.id = w.session_id \
             WHERE s.user_id IN ('{USER}', '{OTHER}')"
        ))
    };
    let before = windows();
    // Another person's metered session writing usage meanwhile: not this person's value, so it must not move the count.
    db.client()
        .batch_execute(
            "WITH s AS (INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
               VALUES ('c3333333-3333-4333-8333-333333333333', 'TEST-elsewhere', '{\"limits\":{}}'::jsonb, 1) RETURNING id)
             INSERT INTO agents.usage_windows (session_id, window_id) SELECT id, 'TEST-elsewhere' FROM s",
        )
        .unwrap();
    let first = data(&create(&d, &me, "service-starter", "picker:one"));
    assert_eq!(s(&first, "state"), "draft");
    assert_eq!(first.get("version"), Some(&Json::int(1)));
    assert_eq!(first.get("perSessionCap"), Some(&Json::Null));
    assert_eq!(s(&first, "name"), "");
    assert_eq!(strings(&first, "tools"), STARTER);
    assert_eq!(
        first.get("findings").unwrap().compact(),
        r#"[{"code":"agents.spend.cap_unset","blocksPublishing":true},{"code":"agents.own.name_unset","blocksPublishing":true}]"#
    );
    assert_eq!(
        s(
            &data(&create(&d, &me, "service-starter", "picker:one")),
            "id"
        ),
        s(&first, "id")
    );
    let second = data(&create(&d, &me, "service-starter", "picker:two"));
    assert_ne!(s(&second, "id"), s(&first, "id"));
    assert_eq!(
        ids(&data(&list(&d, &me, 10))),
        vec![s(&second, "id"), s(&first, "id")]
    );
    // Building an agent moves no value.
    assert_eq!(windows(), before);
}

#[test]
fn saves_the_name_instructions_tools_and_cap_the_cap_clears_its_finding() {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let id = s(
        &data(&create(&d, &me, "service-starter", "picker:save")),
        "id",
    );
    let saved = data(&save(
        &d,
        &me,
        &id,
        "TEST helper",
        "Answer TEST questions.",
        &["trade.quote"],
        Some("1"),
    ));
    assert_eq!(s(&saved, "name"), "TEST helper");
    assert_eq!(strings(&saved, "tools"), vec!["trade.quote"]);
    assert_eq!(s(&saved, "perSessionCap"), "1");
    assert_eq!(saved.get("findings"), Some(&Json::Array(vec![])));
    let got = data(&get(&d, &me, &id));
    assert_eq!(
        (s(&got, "name"), s(&got, "perSessionCap")),
        ("TEST helper".to_owned(), "1".to_owned())
    );
}

#[test]
fn refuses_a_money_tool_and_a_reserved_name_with_their_codes_and_stores_nothing_from_the_refused_save()
 {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let id = s(
        &data(&create(&d, &me, "service-starter", "picker:refuse")),
        "id",
    );
    assert_eq!(
        refused(&save(
            &d,
            &me,
            &id,
            "TEST helper",
            "",
            &["ledger.transfer"],
            None
        )),
        ("BAD_REQUEST".to_owned(), "agents.own.money_tool".to_owned())
    );
    assert_eq!(
        refused(&save(&d, &me, &id, "sessions", "", &[], None)).1,
        "agents.own.reserved_name"
    );
    let got = data(&get(&d, &me, &id));
    assert_eq!(s(&got, "name"), "");
    assert_eq!(strings(&got, "tools"), STARTER);
}

#[test]
fn never_reads_or_writes_another_person_s_agent_and_a_delegated_token_cannot_build() {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let other = person(OTHER);
    let id = s(&data(&create(&d, &me, "blank", "picker:mine")), "id");
    assert_eq!(refused(&get(&d, &other, &id)).0, "NOT_FOUND");
    assert_eq!(
        refused(&save(&d, &other, &id, "x", "", &[], None)).0,
        "NOT_FOUND"
    );
    assert_eq!(data(&list(&d, &other, 10)), Json::Array(vec![]));
    assert_eq!(refused(&get(&d, &other, "not-a-uuid")).0, "NOT_FOUND");
    let delegated = caller(
        USER,
        &["agents:read", "identity:write"],
        Some("66666666-6666-4666-8666-666666666666"),
    );
    assert_eq!(
        refused(&create(&d, &delegated, "blank", "picker:delegated")).0,
        "FORBIDDEN"
    );
    assert_eq!(refused(&list(&d, &delegated, 10)).0, "FORBIDDEN");
    assert_eq!(refused(&get(&d, &delegated, &id)).0, "FORBIDDEN");
    let read_only = caller(USER, &["agents:read"], None);
    assert_eq!(
        refused(&create(&d, &read_only, "blank", "picker:read")).0,
        "FORBIDDEN"
    );
}

#[test]
fn a_service_forwarding_the_person_cannot_read_their_drafts_the_instructions_are_theirs_alone() {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let id = s(&data(&create(&d, &me, "blank", "picker:service")), "id");
    let get_in = obj(&[("id", Json::str(&id))]);
    assert_eq!(
        refused(&query(
            &d,
            "own.get",
            &get_in,
            &with_service(person(USER), "own.get", &get_in, "GET")
        ))
        .0,
        "FORBIDDEN"
    );
    let list_in = obj(&[("limit", Json::int(10))]);
    assert_eq!(
        refused(&query(
            &d,
            "own.list",
            &list_in,
            &with_service(person(USER), "own.list", &list_in, "GET")
        ))
        .0,
        "FORBIDDEN"
    );
    let create_in = obj(&[
        ("template", Json::str("blank")),
        ("createKey", Json::str("picker:service-2")),
    ]);
    assert_eq!(
        refused(&mutate(
            &d,
            "own.create",
            &create_in,
            &with_service(person(USER), "own.create", &create_in, "POST")
        ))
        .0,
        "FORBIDDEN"
    );
    assert_eq!(ids(&data(&list(&d, &me, 10))), vec![id]);
}

#[test]
fn refuses_a_nul_in_the_name_or_instructions_with_its_code_and_stores_nothing_from_the_refused_save()
 {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    let me = person(USER);
    let id = s(
        &data(&create(&d, &me, "service-starter", "picker:nul")),
        "id",
    );
    let bad = (
        "BAD_REQUEST".to_owned(),
        "agents.own.text_invalid".to_owned(),
    );
    assert_eq!(
        refused(&save(&d, &me, &id, "TEST\u{0}helper", "", &[], Some("1"))),
        bad
    );
    assert_eq!(
        refused(&save(
            &d,
            &me,
            &id,
            "TEST helper",
            "a\u{0}b",
            &[],
            Some("1")
        )),
        bad
    );
    let got = data(&get(&d, &me, &id));
    assert_eq!(
        (s(&got, "name"), s(&got, "instructions")),
        (String::new(), String::new())
    );
    assert_eq!(got.get("perSessionCap"), Some(&Json::Null));
    assert_eq!(got.get("version"), Some(&Json::int(1)));
}

#[test]
fn keeps_at_most_the_limit_of_agents_per_person_the_next_create_refuses_a_retried_key_still_returns_its_draft()
 {
    let db = db_or_skip!();
    let d = Arc::new(door(&db, Own::unwired()));
    let me = person(USER);
    // All at once, as the TypeScript's Promise.all: the person's lock keeps the count from being raced past.
    let created: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..OWN_AGENTS_MAX)
            .map(|n| {
                let (d, me) = (Arc::clone(&d), me.clone());
                scope.spawn(move || {
                    s(
                        &data(&create(&d, &me, "blank", &format!("picker:many-{n}"))),
                        "id",
                    )
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let unique: std::collections::BTreeSet<&String> = created.iter().collect();
    assert_eq!(unique.len(), usize::try_from(OWN_AGENTS_MAX).unwrap());
    assert_eq!(
        refused(&create(&d, &me, "blank", "picker:one-too-many")),
        ("BAD_REQUEST".to_owned(), "agents.own.too_many".to_owned())
    );
    assert_eq!(
        s(&data(&create(&d, &me, "blank", "picker:many-0")), "id"),
        created[0]
    );
    assert_eq!(
        ids(&data(&list(&d, &me, 200))).len(),
        usize::try_from(OWN_AGENTS_MAX).unwrap()
    );
    // The limit is per person: someone else still builds.
    assert_eq!(
        s(
            &data(&create(&d, &person(OTHER), "blank", "picker:other")),
            "state"
        ),
        "draft"
    );
}

#[test]
fn refuses_a_template_it_does_not_offer() {
    let db = db_or_skip!();
    let d = door(&db, Own::unwired());
    assert_eq!(
        refused(&create(&d, &person(USER), "trader", "picker:bad")).1,
        "agents.own.template_unknown"
    );
}

// ── identity.test.ts, "drafting with the assistant" ─────────────────────────

fn drafting(model: Option<&str>) -> Own {
    own_with(|o| o.assistant_model = model.map(str::to_owned))
}

#[test]
fn with_the_model_unset_drafting_refuses_owner_decision_and_nothing_is_saved() {
    let db = db_or_skip!();
    let d = door(&db, drafting(None));
    let me = person(USER);
    assert_eq!(
        data(&query_none(&d, "own.assistant.state", &me)).compact(),
        r#"{"engine":null}"#
    );
    assert_eq!(
        refused(&mutate(
            &d,
            "own.assistant.draft",
            &obj(&[("description", Json::str(DESCRIPTION))]),
            &me
        )),
        (
            "PRECONDITION_FAILED".to_owned(),
            "owner.decision".to_owned()
        )
    );
    assert_eq!(data(&list(&d, &me, 200)), Json::Array(vec![]));
}

#[test]
fn a_model_with_no_drafting_adapter_drafts_nothing() {
    let db = db_or_skip!();
    let d = door(&db, drafting(Some("some-model")));
    let me = person(USER);
    assert_eq!(
        data(&query_none(&d, "own.assistant.state", &me)).compact(),
        r#"{"engine":"live"}"#
    );
    assert_eq!(
        refused(&mutate(
            &d,
            "own.assistant.draft",
            &obj(&[("description", Json::str(DESCRIPTION))]),
            &me
        ))
        .1,
        "agents.assistant.engine_unavailable"
    );
}

#[test]
fn a_draft_is_saved_only_once_accepted_through_the_validator_once_per_accept_key() {
    let db = db_or_skip!();
    let d = door(&db, drafting(Some("test-engine")));
    let me = person(USER);
    assert_eq!(
        data(&query_none(&d, "own.assistant.state", &me)).compact(),
        r#"{"engine":"test"}"#
    );
    let draft = data(&mutate(
        &d,
        "own.assistant.draft",
        &obj(&[("description", Json::str(DESCRIPTION))]),
        &me,
    ));
    assert_eq!(
        draft.compact(),
        Json::obj([
            (
                "name",
                Json::str("TEST draft: answer questions about my orders and never move")
            ),
            (
                "instructions",
                Json::str(format!("TEST draft from your description. {DESCRIPTION}"))
            ),
            (
                "tools",
                Json::Array(vec![
                    Json::str("support.kb.search"),
                    Json::str("trade.markets.list")
                ])
            ),
            ("leftOut", Json::Array(vec![])),
            ("engine", Json::str("test")),
        ])
        .compact()
    );
    assert_eq!(data(&list(&d, &me, 200)), Json::Array(vec![]));
    let accept = |tools: Json, key: &str| {
        mutate(
            &d,
            "own.assistant.accept",
            &obj(&[
                ("name", draft.get("name").unwrap().clone()),
                ("instructions", draft.get("instructions").unwrap().clone()),
                ("tools", tools),
                ("acceptKey", Json::str(key)),
            ]),
            &me,
        )
    };
    let accepted = data(&accept(
        draft.get("tools").unwrap().clone(),
        "accept:one-key",
    ));
    assert_eq!(s(&accepted, "name"), s(&draft, "name"));
    assert_eq!(s(&accepted, "instructions"), s(&draft, "instructions"));
    assert_eq!(strings(&accepted, "tools"), strings(&draft, "tools"));
    assert_eq!(s(&accepted, "state"), "draft");
    assert_eq!(s(&accepted, "template"), "blank");
    assert_eq!(
        data(&accept(
            draft.get("tools").unwrap().clone(),
            "accept:one-key"
        )),
        accepted
    );
    assert_eq!(ids(&data(&list(&d, &me, 200))).len(), 1);
    // An accept carrying a tool the validator refuses saves nothing.
    let mut more = strings(&draft, "tools");
    more.push("ledger.transfer".to_owned());
    assert_eq!(
        refused(&accept(
            Json::Array(more.into_iter().map(Json::str).collect()),
            "accept:two-key"
        ))
        .1,
        "agents.own.money_tool"
    );
    assert_eq!(ids(&data(&list(&d, &me, 200))).len(), 1);
}

// ── guardrails.test.ts, "standing rules (J-agents-05 #1)" ───────────────────

#[test]
fn saves_ask_before_for_the_comment_tool_refuses_acting_without_asking_on_it_and_loosening_the_baseline_storing_neither()
 {
    let db = db_or_skip!();
    let baseline = parse_policy_baseline(Some(
        r#"{"own_data":"act_on_request","market_data":"act_on_request","draft_write":"ask_before","live_write":"act_on_request"}"#,
    ))
    .unwrap();
    let d = door(&db, own_with(|o| o.baseline = baseline));
    let me = caller(
        USER,
        &["agents:read", "agents:execute", "identity:write"],
        None,
    );
    let id = s(
        &data(&create(&d, &me, "service-starter", "guard:rules")),
        "id",
    );
    data(&save(
        &d,
        &me,
        &id,
        "TEST helper",
        "",
        &["support.kb.search", "support.ticket.comment"],
        Some("1"),
    ));
    let rule = |tool: &str, choice: &str| {
        mutate(
            &d,
            "own.rules.save",
            &obj(&[
                ("id", Json::str(&id)),
                ("tool", Json::str(tool)),
                ("choice", Json::str(choice)),
            ]),
            &me,
        )
    };
    let saved = data(&rule("support.ticket.comment", "ask_before"));
    assert_eq!(
        (s(&saved, "tool"), s(&saved, "choice")),
        ("support.ticket.comment".to_owned(), "ask_before".to_owned())
    );
    // The same rule again is the same row.
    assert_eq!(data(&rule("support.ticket.comment", "ask_before")), saved);
    assert_eq!(
        refused(&rule("support.ticket.comment", "act_without_asking")).1,
        "agents.rule_invalid"
    );
    assert_eq!(
        refused(&rule("support.kb.search", "act_without_asking")).1,
        "agents.baseline_loosen_refused"
    );
    assert_eq!(
        refused(&rule("trade.quote", "ask_before")).1,
        "agents.tool_not_declared"
    );
    assert_eq!(
        data(&query(
            &d,
            "own.rules.list",
            &obj(&[("id", Json::str(&id))]),
            &me
        )),
        Json::Array(vec![saved])
    );
}
