//! The team slice on a real Postgres, the crate's store, runs and spend gate: `services/svc-agents/src/team/store.test.ts`
//! and `team/runs.test.ts`, case for case, and the team router's refusals through the door. svc-bank's team read is a
//! fake that answers as the team stands now, so a member removed from it is gone at the next read. Without
//! `TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL` it skips; with `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::money::{Amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::db::{self, Store};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::metering::Metering;
use svc_agents::runtime::holds::{self, HoldError, ReserveInput};
use svc_agents::runtime::{Rt, Runtime};
use svc_agents::team::membership::{Member, Membership, TeamMembership};
use svc_agents::team::runs::TeamRuns;
use svc_agents::team::store::{GrantInput, PoolInput, ProjectInput, TeamStore};
use svc_agents::team::{Team, TeamError, TeamFail, team_error};

const BUSINESS: &str = "99999999-9999-4999-8999-999999999999";
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const ANA: &str = "22222222-2222-4222-8222-222222222222";
const BEN: &str = "33333333-3333-4333-8333-333333333333";
const OUTSIDER: &str = "44444444-4444-4444-8444-444444444444";
const OTHER_BUSINESS: &str = "88888888-8888-4888-8888-888888888888";
const ANA_SESSION: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEN_SESSION: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER_SESSION: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET: &str = "an-agents-team-roles-test-secret-of-32+";

#[derive(Default)]
struct TeamState {
    members: Vec<String>,
    roles: BTreeMap<String, String>,
    closed: bool,
    down: bool,
}

/// svc-bank's answer, as the team stands now.
#[derive(Clone)]
struct FakeTeam(Arc<Mutex<TeamState>>);

impl FakeTeam {
    fn new() -> FakeTeam {
        FakeTeam(Arc::new(Mutex::new(TeamState {
            members: vec![ANA.to_owned(), BEN.to_owned()],
            ..TeamState::default()
        })))
    }
    fn set(&self, f: impl FnOnce(&mut TeamState)) {
        f(&mut self.0.lock().unwrap());
    }
}

impl TeamMembership for FakeTeam {
    fn read(&self, user_id: &str, business_id: &str) -> Result<Membership, TeamError> {
        let s = self.0.lock().unwrap();
        if s.down {
            // `connect ECONNREFUSED` from the port: `readTeam` makes it unavailable.
            return Err(team_error(
                "agents.membership_unavailable",
                "Business team could not be read",
            ));
        }
        if business_id != BUSINESS || (user_id != OWNER && !s.members.iter().any(|m| m == user_id))
        {
            return Ok(Membership::NotMember);
        }
        if s.closed {
            return Ok(Membership::BusinessClosed);
        }
        let role_of = |m: &str| {
            s.roles.get(m).cloned().unwrap_or_else(|| {
                if m == OWNER {
                    "admin".to_owned()
                } else {
                    "maker".to_owned()
                }
            })
        };
        let mut members = vec![OWNER.to_owned()];
        members.extend(s.members.iter().cloned());
        Ok(Membership::Team {
            business_id: BUSINESS.to_owned(),
            role: role_of(user_id),
            members: members
                .iter()
                .map(|m| Member {
                    user_id: m.clone(),
                    role: role_of(m),
                })
                .collect(),
        })
    }
}

struct World {
    db: TestDb,
    store: Store,
    team: FakeTeam,
    gateway: GatewaySlice,
    metering: Metering,
    runtime: Runtime,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        db.migrated();
        let store = db::open(&db.url, "svc-agents", 8, false).unwrap();
        let w = World {
            store,
            team: FakeTeam::new(),
            gateway: GatewaySlice::unwired("IFC"),
            metering: Metering::unwired("IFC", 60),
            runtime: Runtime::unwired(),
            db,
        };
        // The three probe sessions `runs.test.ts` links to the business.
        w.exec(&format!(
            "INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
             VALUES ('{ANA_SESSION}', '{ANA}', 'probe', '{{\"limits\":{{}}}}', 1),
                    ('{BEN_SESSION}', '{BEN}', 'probe', '{{\"limits\":{{}}}}', 1),
                    ('{OUTSIDER_SESSION}', '{OUTSIDER}', 'probe', '{{\"limits\":{{}}}}', 1);
             INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
             VALUES ('{ANA_SESSION}', '{BUSINESS}', '{ANA}', 'a'), ('{BEN_SESSION}', '{BUSINESS}', '{BEN}', 'b'),
                    ('{OUTSIDER_SESSION}', '{BUSINESS}', '{OUTSIDER}', 'c');"
        ));
        Some(w)
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    fn exec(&self, sql: &str) {
        self.db.client().batch_execute(sql).unwrap();
    }

    fn rows(&self, sql: &str) -> Vec<postgres::Row> {
        self.db.client().query(sql, &[]).unwrap()
    }

    fn store_with(&self, fee: Option<&'static str>) -> TeamStore<'_> {
        TeamStore {
            pool: self.pool(),
            membership: &self.team,
            fee_asset_id: fee,
        }
    }

    fn store(&self) -> TeamStore<'_> {
        self.store_with(Some("IFC"))
    }

    fn runs(&self) -> TeamRuns<'_> {
        TeamRuns {
            x: Rt {
                rt: &self.runtime,
                pool: self.pool(),
                gateway: &self.gateway.gateway,
                m: &self.metering,
                now: system_now(),
            },
            membership: &self.team,
            fee_asset_id: "IFC",
        }
    }

    fn grant(
        &self,
        member: &str,
        role: &str,
        allow: bool,
        deny: bool,
        revision: i64,
    ) -> Result<Json, TeamFail> {
        self.store().set_grant(&GrantInput {
            actor_user_id: OWNER,
            business_id: BUSINESS,
            member_user_id: member,
            role,
            allow,
            deny,
            revision,
        })
    }

    fn pool_set(
        &self,
        limit: &str,
        allocations: &[(&str, &str)],
        revision: i64,
    ) -> Result<Json, TeamFail> {
        self.store().set_pool(&PoolInput {
            actor_user_id: OWNER,
            business_id: BUSINESS,
            limit: Some(limit),
            allocations: allocations.iter().map(|(m, a)| (*m, Some(*a))).collect(),
            revision,
        })
    }

    fn project(
        &self,
        name: &str,
        limit: &str,
        members: &[&str],
        seq: i64,
    ) -> Result<Json, TeamFail> {
        self.store().create_project(&ProjectInput {
            actor_user_id: OWNER,
            business_id: BUSINESS,
            name: Some(name),
            limit: Some(limit),
            member_user_ids: members.to_vec(),
            seq,
        })
    }

    fn view(&self, user: &str) -> Json {
        self.store().view(user, BUSINESS).unwrap()
    }

    /// `spend.reserve({ ..., agentCap: '100', teamRun })`.
    fn reserve(
        &self,
        user: &str,
        session: &str,
        key: &str,
        amount: &str,
        team_run: bool,
    ) -> Result<holds::Reservation, HoldError> {
        reserve_on(self.pool(), user, session, key, amount, team_run)
    }

    fn held(&self) -> Amount {
        let total: String = self.rows(
            "SELECT COALESCE(SUM(amount), 0)::text FROM agents.spend_reservations WHERE status = 'held'",
        )[0]
        .get(0);
        parse_amount(&total).unwrap()
    }

    /// `OwnAgentStore.create(ANA, 'service-starter', ...)`: the service-starter template's draft.
    fn ana_agent(&self) -> String {
        self.rows(&format!(
            "INSERT INTO agents.own_agents (owner_id, template, tools, create_key)
             VALUES ('{ANA}', 'service-starter',
                     '[\"support.kb.search\",\"support.ticket.read\",\"identity.account.read\"]', 'team-test-agent-1')
             RETURNING id::text"
        ))[0]
            .get(0)
    }
}

fn reserve_on(
    pool: &Pool,
    user: &str,
    session: &str,
    key: &str,
    amount: &str,
    team_run: bool,
) -> Result<holds::Reservation, HoldError> {
    holds::reserve(
        pool,
        &ReserveInput {
            user_id: user,
            session_id: session,
            reservation_key: key,
            asset_id: "IFC",
            amount: parse_amount(amount).unwrap(),
            now: system_now(),
            agent_cap: Some(parse_amount("100").unwrap()),
            funds: None,
            overage_grace: None,
            team_run,
        },
    )
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

fn code(r: Result<Json, TeamFail>) -> String {
    match r {
        Err(TeamFail::Team(e)) => e.code.to_owned(),
        Err(TeamFail::Own(c)) => c.to_owned(),
        Err(other) => panic!("expected a team refusal, got {other:?}"),
        Ok(j) => panic!("expected a refusal, got {}", j.compact()),
    }
}

fn hold_code(r: Result<holds::Reservation, HoldError>) -> (String, Vec<(String, Json)>) {
    match r {
        Err(HoldError::Denied(d)) => (d.error.code.to_owned(), d.params),
        Err(other) => panic!("expected a refusal, got {other:?}"),
        Ok(r) => panic!("expected a refusal, got a {} hold", r.status),
    }
}

fn param<'a>(params: &'a [(String, Json)], k: &str) -> &'a Json {
    &params.iter().find(|(n, _)| n == k).unwrap().1
}

fn member<'a>(view: &'a Json, user: &str) -> &'a Json {
    let Some(Json::Array(members)) = view.get("members") else {
        panic!("no members")
    };
    members
        .iter()
        .find(|m| m.get("userId") == Some(&Json::str(user)))
        .unwrap()
}

fn strs(v: &Json) -> Vec<String> {
    match v {
        Json::Array(items) => items
            .iter()
            .map(|i| match i {
                Json::String(s) => s.clone(),
                Json::Object(_) => match i.get("userId") {
                    Some(Json::String(s)) => s.clone(),
                    _ => panic!("no userId"),
                },
                other => panic!("not a string: {other:?}"),
            })
            .collect(),
        other => panic!("not a list: {other:?}"),
    }
}

fn s(v: Option<&Json>) -> Json {
    v.cloned().unwrap_or(Json::Null)
}

fn j(text: &str) -> Json {
    json::parse(text).unwrap()
}

// ---- store.test.ts: roles

#[test]
fn roles_lists_each_member_with_every_role_granted_and_refuses_a_grant_to_a_non_member() {
    let w = world_or_skip!();
    for role in [
        "creator",
        "runner",
        "approver",
        "log_reader",
        "spend_reader",
    ] {
        w.grant(ANA, role, true, false, 1).unwrap();
    }
    let view = w.view(OWNER);
    assert_eq!(strs(&s(view.get("members"))), vec![OWNER, ANA, BEN]);
    assert_eq!(
        strs(&s(member(&view, ANA).get("effective"))),
        vec![
            "creator",
            "runner",
            "approver",
            "log_reader",
            "spend_reader"
        ]
    );
    assert!(strs(&s(member(&view, BEN).get("effective"))).is_empty());
    assert_eq!(
        code(w.grant(OUTSIDER, "runner", true, false, 1)),
        "agents.role_not_member"
    );
    assert!(
        w.rows(&format!(
            "SELECT 1 FROM agents.team_role_grants WHERE member_user_id = '{OUTSIDER}'"
        ))
        .is_empty()
    );
}

#[test]
fn roles_make_deny_win_over_allow() {
    let w = world_or_skip!();
    w.grant(BEN, "runner", true, true, 1).unwrap();
    let view = w.view(OWNER);
    let ben = member(&view, BEN);
    let Some(Json::Array(grants)) = ben.get("grants") else {
        panic!()
    };
    let runner = grants
        .iter()
        .find(|g| g.get("role") == Some(&Json::str("runner")))
        .unwrap();
    assert_eq!(
        runner,
        &j(r#"{"role":"runner","allow":true,"deny":true,"version":1}"#)
    );
    assert!(!strs(&s(ben.get("effective"))).contains(&"runner".to_owned()));
}

#[test]
fn roles_replay_a_retried_change_once_and_refuse_a_stale_or_skipped_change() {
    let w = world_or_skip!();
    assert_eq!(
        w.grant(ANA, "runner", true, false, 1)
            .unwrap()
            .get("replayed"),
        Some(&Json::Bool(false))
    );
    assert_eq!(
        w.grant(ANA, "runner", true, false, 1)
            .unwrap()
            .get("replayed"),
        Some(&Json::Bool(true))
    );
    assert_eq!(
        code(w.grant(ANA, "runner", false, false, 1)),
        "agents.team_change_stale"
    );
    assert_eq!(
        code(w.grant(ANA, "runner", false, false, 3)),
        "agents.team_change_stale"
    );
    let rows = w.rows(&format!("SELECT idempotency_key, version FROM agents.team_role_grants WHERE member_user_id = '{ANA}'"));
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].get::<_, String>(0),
        format!("agents:role:{BUSINESS}:{ANA}:runner:1")
    );
    assert_eq!(rows[0].get::<_, i32>(1), 1);
}

#[test]
fn roles_change_only_by_a_business_admin_or_non_signing_admin_and_an_unknown_role_refuses() {
    let w = world_or_skip!();
    let as_ana = |w: &World| {
        w.store().set_grant(&GrantInput {
            actor_user_id: ANA,
            business_id: BUSINESS,
            member_user_id: BEN,
            role: "runner",
            allow: true,
            deny: false,
            revision: 1,
        })
    };
    assert_eq!(code(as_ana(&w)), "agents.role_admin_only");
    assert_eq!(
        code(w.grant(ANA, "treasurer", true, false, 1)),
        "agents.role_invalid"
    );
    assert_eq!(w.view(ANA).get("canManage"), Some(&Json::Bool(false)));
    w.team.set(|s| {
        s.roles
            .insert(ANA.to_owned(), "non_signing_admin".to_owned());
    });
    assert_eq!(w.view(ANA).get("canManage"), Some(&Json::Bool(true)));
    assert_eq!(
        as_ana(&w).unwrap().get("replayed"),
        Some(&Json::Bool(false))
    );
}

#[test]
fn roles_refuse_a_person_not_on_the_business_they_name_or_a_business_they_are_not_on() {
    let w = world_or_skip!();
    assert_eq!(
        code(w.store().view(OUTSIDER, BUSINESS)),
        "agents.team_not_member"
    );
    assert_eq!(
        code(w.store().view(OWNER, OTHER_BUSINESS)),
        "agents.team_not_member"
    );
}

// ---- store.test.ts: pool

#[test]
fn pool_refuses_a_blank_allocation_by_member_and_saves_nothing_then_shows_the_limit_once_every_allocation_is_set()
 {
    let w = world_or_skip!();
    let blank = w
        .store()
        .set_pool(&PoolInput {
            actor_user_id: OWNER,
            business_id: BUSINESS,
            limit: Some("10"),
            allocations: vec![(ANA, Some("4")), (BEN, Some(""))],
            revision: 1,
        })
        .unwrap();
    assert_eq!(
        blank,
        j(&format!(
            r#"{{"ok":false,"code":"agents.pool_allocation_unset","memberUserIds":["{BEN}"]}}"#
        ))
    );
    assert_eq!(w.view(OWNER).get("pool"), Some(&Json::Null));

    let set = w.pool_set("10.50", &[(ANA, "4"), (BEN, "0")], 1).unwrap();
    assert_eq!(
        set,
        j(
            r#"{"ok":true,"pool":{"assetId":"IFC","limit":"10.5","allocated":"4","version":1},"replayed":false}"#
        )
    );
    let view = w.view(OWNER);
    assert_eq!(
        view.get("pool"),
        Some(&j(
            r#"{"assetId":"IFC","limit":"10.5","allocated":"4","version":1}"#
        ))
    );
    let Some(Json::Array(members)) = view.get("members") else {
        panic!()
    };
    let allocations: Vec<Json> = members.iter().map(|m| s(m.get("allocation"))).collect();
    assert_eq!(
        allocations,
        vec![Json::Null, Json::str("4"), Json::str("0")]
    );
}

#[test]
fn pool_refuses_a_blank_or_zero_limit_an_allocation_above_it_a_non_member_and_an_unset_fee_asset() {
    let w = world_or_skip!();
    let set = |store: &TeamStore<'_>,
               limit: &str,
               allocations: Vec<(&'static str, Option<&'static str>)>| {
        store.set_pool(&PoolInput {
            actor_user_id: OWNER,
            business_id: BUSINESS,
            limit: Some(limit),
            allocations,
            revision: 1,
        })
    };
    let base = || vec![(ANA, Some("1"))];
    assert_eq!(
        code(set(&w.store(), " ", base())),
        "agents.pool_limit_unset"
    );
    assert_eq!(
        code(set(&w.store(), "0", base())),
        "agents.pool_limit_invalid"
    );
    assert_eq!(
        code(set(&w.store(), "0.5", base())),
        "agents.pool_allocation_invalid"
    );
    assert_eq!(
        code(set(
            &w.store(),
            "5",
            vec![(ANA, Some("3")), (BEN, Some("2.000000000000000001"))]
        )),
        "agents.pool_over_limit"
    );
    assert_eq!(
        code(set(&w.store(), "5", vec![(OUTSIDER, Some("1"))])),
        "agents.role_not_member"
    );
    assert_eq!(
        code(set(&w.store_with(None), "5", base())),
        "agents.fee_asset_unset"
    );
    assert!(w.rows("SELECT 1 FROM agents.team_pools").is_empty());
}

#[test]
fn pool_keys_change_n_as_agents_pool_business_n_and_replays_it_once() {
    let w = world_or_skip!();
    w.pool_set("5", &[(ANA, "2")], 1).unwrap();
    let again = w.pool_set("5", &[(ANA, "2")], 1).unwrap();
    assert_eq!(
        (again.get("ok"), again.get("replayed")),
        (Some(&Json::Bool(true)), Some(&Json::Bool(true)))
    );
    assert_eq!(
        code(w.pool_set("6", &[(ANA, "2")], 1)),
        "agents.team_change_stale"
    );
    let key: String = w.rows("SELECT idempotency_key FROM agents.team_pools")[0].get(0);
    assert_eq!(key, format!("agents:pool:{BUSINESS}:1"));
}

// ---- store.test.ts: projects

#[test]
fn projects_limit_the_members_named_and_not_the_others_and_a_blank_limit_refuses() {
    let w = world_or_skip!();
    assert_eq!(
        code(w.project("TEST launch", "", &[ANA], 1)),
        "agents.project_limit_unset"
    );
    let made = w.project("TEST launch", "3", &[ANA], 1).unwrap();
    let project = s(made.get("project"));
    assert_eq!(project.get("name"), Some(&Json::str("TEST launch")));
    assert_eq!(project.get("limit"), Some(&Json::str("3")));
    assert_eq!(strs(&s(project.get("memberUserIds"))), vec![ANA]);
    let view = w.view(OWNER);
    assert_eq!(
        view.get("projects"),
        Some(&Json::Array(vec![project.clone()]))
    );
    assert_eq!(view.get("nextProjectSeq"), Some(&Json::int(2)));
    assert_eq!(
        w.project("TEST launch", "3", &[ANA], 1)
            .unwrap()
            .get("replayed"),
        Some(&Json::Bool(true))
    );
    assert_eq!(
        code(w.project("TEST other", "3", &[OUTSIDER], 2)),
        "agents.role_not_member"
    );
}

// ---- store.test.ts: a removed member

#[test]
fn a_removed_member_drops_from_every_view_with_their_grants_allocation_and_project_limit_and_their_next_request_fails()
 {
    let w = world_or_skip!();
    w.grant(BEN, "runner", true, false, 1).unwrap();
    w.pool_set("5", &[(BEN, "2")], 1).unwrap();
    w.project("TEST launch", "3", &[ANA, BEN], 1).unwrap();
    w.team.set(|s| s.members = vec![ANA.to_owned()]);
    let view = w.view(OWNER);
    assert_eq!(strs(&s(view.get("members"))), vec![OWNER, ANA]);
    assert_eq!(s(view.get("pool")).get("allocated"), Some(&Json::str("0")));
    let Some(Json::Array(projects)) = view.get("projects") else {
        panic!()
    };
    assert_eq!(strs(&s(projects[0].get("memberUserIds"))), vec![ANA]);
    assert_eq!(
        code(w.store().view(BEN, BUSINESS)),
        "agents.team_not_member"
    );
    assert_eq!(
        code(w.grant(BEN, "runner", false, false, 2)),
        "agents.role_not_member"
    );
}

#[test]
fn a_closed_business_and_an_unreadable_team_refuse_never_an_empty_one() {
    let w = world_or_skip!();
    w.team.set(|s| s.closed = true);
    assert_eq!(
        code(w.store().view(OWNER, BUSINESS)),
        "agents.business_closed"
    );
    w.team.set(|s| {
        s.closed = false;
        s.down = true;
    });
    assert_eq!(
        code(w.store().view(OWNER, BUSINESS)),
        "agents.membership_unavailable"
    );
}

// ---- store.test.ts: team router, through the door

fn door(w: &World, team: Team) -> AgentsDoor {
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
        services: ServiceAuth::unwired(),
        env,
        now: system_now,
        store: db::open(&w.db.url, "svc-agents", 2, false).unwrap(),
        gateway: GatewaySlice::unwired("IFC"),
        ready: ReadyInput::unwired(),
        metering: Metering::unwired("IFC", 60),
        runtime: Runtime::unwired(),
        background: svc_agents::background::Settings::default(),
        advisors: svc_agents::advisors::Advisors::unwired(),
        own: svc_agents::own::Own::unwired(),
        team,
    })
    .unwrap()
}

/// `callerFor(userId, { kid })`: scopes `agents:read` and `identity:write`, signed for DE.
fn caller(user: &str, kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub".to_owned(), Json::str(user)),
        ("userId".to_owned(), Json::str(user)),
        (
            "sid".to_owned(),
            Json::str("55555555-5555-4555-8555-555555555555"),
        ),
        (
            "scopes".to_owned(),
            Json::Array(vec![Json::str("agents:read"), Json::str("identity:write")]),
        ),
        ("tier".to_owned(), Json::str("none")),
        ("mfa".to_owned(), Json::Bool(false)),
        (
            "expiresAt".to_owned(),
            Json::str("2099-01-01T00:00:00.000Z"),
        ),
    ];
    if let Some(kid) = kid {
        fields.push(("kid".to_owned(), Json::str(kid)));
    }
    let raw = Json::Object(fields).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

fn call(
    door: &AgentsDoor,
    method: &str,
    path: &str,
    input: &Json,
    headers: &[(String, String)],
) -> (u16, Json) {
    let body = input.compact();
    let url = if method == "GET" {
        let enc: String = body
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    char::from(b).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        format!("/trpc/{path}?input={enc}")
    } else {
        format!("/trpc/{path}")
    };
    let res = door.handle(&Request {
        method,
        url: &url,
        headers,
        body: if method == "GET" { "" } else { &body },
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn error_of(answer: &(u16, Json)) -> (String, Option<String>) {
    let data = answer.1.get("error").and_then(|e| e.get("data")).unwrap();
    let code = match data.get("code") {
        Some(Json::String(c)) => c.clone(),
        _ => panic!("no code"),
    };
    let cause = match data.get("cause").and_then(|c| c.get("code")) {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    (code, cause)
}

#[test]
fn the_team_router_answers_the_callers_business_and_carries_each_refusals_code() {
    let w = world_or_skip!();
    let app = door(
        &w,
        Team {
            membership: Some(Box::new(w.team.clone())),
        },
    );
    let owner = caller(OWNER, None);
    let grant = |member: &str, revision: i64, allow: bool| {
        j(&format!(
            r#"{{"businessId":"{BUSINESS}","memberUserId":"{member}","role":"runner","allow":{allow},"deny":false,"revision":{revision}}}"#
        ))
    };
    let set = call(
        &app,
        "POST",
        "team.grants.set",
        &grant(ANA, 1, true),
        &owner,
    );
    assert_eq!(set.0, 200, "{}", set.1.compact());
    let view = call(
        &app,
        "GET",
        "team.view",
        &j(&format!(r#"{{"businessId":"{BUSINESS}"}}"#)),
        &owner,
    );
    assert_eq!(view.0, 200, "{}", view.1.compact());
    let data = view.1.get("result").and_then(|r| r.get("data")).unwrap();
    assert_eq!(strs(&s(member(data, ANA).get("effective"))), vec!["runner"]);

    let refused = call(
        &app,
        "POST",
        "team.grants.set",
        &grant(OUTSIDER, 1, true),
        &owner,
    );
    assert_eq!(
        error_of(&refused),
        (
            "FORBIDDEN".to_owned(),
            Some("agents.role_not_member".to_owned())
        )
    );
    let keyed = call(
        &app,
        "POST",
        "team.grants.set",
        &grant(ANA, 2, false),
        &caller(OWNER, Some("key-1")),
    );
    assert_eq!(error_of(&keyed).0, "FORBIDDEN");

    let dark = door(&w, Team::unwired());
    let unread = call(
        &dark,
        "GET",
        "team.view",
        &j(&format!(r#"{{"businessId":"{BUSINESS}"}}"#)),
        &owner,
    );
    assert_eq!(
        error_of(&unread),
        (
            "SERVICE_UNAVAILABLE".to_owned(),
            Some("agents.membership_unavailable".to_owned())
        )
    );
}

// ---- runs.test.ts: a team hold

#[test]
fn a_team_hold_refuses_a_run_on_a_team_session_from_any_route_but_the_team_run_route() {
    let w = world_or_skip!();
    w.pool_set("3", &[(ANA, "2"), (BEN, "1")], 1).unwrap();
    // Another route reaches the spend gate without the team route's flag: a hand-made `team:` key does not stand in for
    // the membership and role read.
    for key in ["team:forged", "plain-key"] {
        assert_eq!(
            hold_code(w.reserve(ANA, ANA_SESSION, key, "0.5", false)).0,
            "agents.session_not_found"
        );
    }
    // The flag alone does not either: the team route's key carries its prefix.
    assert_eq!(
        hold_code(w.reserve(ANA, ANA_SESSION, "plain", "0.5", true)).0,
        "agents.session_not_found"
    );
    assert_eq!(w.held(), 0);
    assert_eq!(
        w.reserve(ANA, ANA_SESSION, "team:a1", "0.5", true)
            .unwrap()
            .status,
        "held"
    );
}

#[test]
fn a_team_hold_refuses_a_run_past_the_members_allocation_and_keeps_the_pool_within_its_limit() {
    let w = world_or_skip!();
    w.pool_set("3", &[(ANA, "2"), (BEN, "1")], 1).unwrap();
    assert_eq!(
        w.reserve(ANA, ANA_SESSION, "team:a1", "1.5", true)
            .unwrap()
            .status,
        "held"
    );
    let (c, params) = hold_code(w.reserve(ANA, ANA_SESSION, "team:a2", "1", true));
    assert_eq!(c, "agents.team.allocation_exceeded");
    assert_eq!(param(&params, "scope"), &Json::str("allocation"));
    assert_eq!(param(&params, "limit"), &Json::str("2"));
    assert_eq!(w.held(), parse_amount("1.5").unwrap());
    let view = w.view(OWNER);
    assert_eq!(view.get("used"), Some(&Json::str("1.5")));
    assert_eq!(member(&view, ANA).get("used"), Some(&Json::str("1.5")));
    assert_eq!(member(&view, BEN).get("used"), Some(&Json::str("0")));
}

#[test]
fn a_team_hold_refuses_a_member_with_no_allocation_and_a_hold_the_team_run_route_did_not_make() {
    let w = world_or_skip!();
    w.pool_set("3", &[(ANA, "2")], 1).unwrap();
    assert_eq!(
        hold_code(w.reserve(BEN, BEN_SESSION, "team:b1", "0.1", true)).0,
        "agents.team.allocation_unset"
    );
    assert_eq!(
        hold_code(w.reserve(ANA, ANA_SESSION, "plain-key", "0.1", true)).0,
        "agents.session_not_found"
    );
    assert_eq!(w.held(), 0);
}

#[test]
fn a_team_hold_limits_a_projects_members_together_and_not_the_members_outside_it() {
    let w = world_or_skip!();
    w.pool_set("4", &[(ANA, "2"), (BEN, "2")], 1).unwrap();
    w.project("TEST launch", "1", &[ANA], 1).unwrap();
    let (c, params) = hold_code(w.reserve(ANA, ANA_SESSION, "team:a1", "1.5", true));
    assert_eq!(c, "agents.team.project_limit_exceeded");
    assert_eq!(param(&params, "scope"), &Json::str("project"));
    assert_eq!(param(&params, "limit"), &Json::str("1"));
    assert_eq!(
        w.reserve(BEN, BEN_SESSION, "team:b1", "1.5", true)
            .unwrap()
            .status,
        "held"
    );
}

#[test]
fn a_team_hold_refuses_a_run_once_the_pool_limit_is_lowered_below_what_was_spent() {
    let w = world_or_skip!();
    w.pool_set("3", &[(ANA, "2"), (BEN, "1")], 1).unwrap();
    w.reserve(ANA, ANA_SESSION, "team:a1", "1.5", true).unwrap();
    w.pool_set("1", &[(ANA, "0.5"), (BEN, "0.5")], 2).unwrap();
    assert_eq!(
        hold_code(w.reserve(BEN, BEN_SESSION, "team:b1", "0.5", true)).0,
        "agents.team.pool_exceeded"
    );
}

#[test]
fn a_team_hold_never_lets_runs_at_once_pass_the_pool_limit_invariant() {
    let w = world_or_skip!();
    w.pool_set("2", &[(ANA, "1"), (BEN, "1")], 1).unwrap();
    let outcomes: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..12)
            .map(|i| {
                let pool = w.pool();
                scope.spawn(move || {
                    let (user, session) = if i % 2 == 1 {
                        (ANA, ANA_SESSION)
                    } else {
                        (BEN, BEN_SESSION)
                    };
                    match reserve_on(pool, user, session, &format!("team:race-{i}"), "0.3", true) {
                        Ok(_) => "held".to_owned(),
                        Err(HoldError::Denied(d)) => d.error.code.to_owned(),
                        Err(other) => format!("{other:?}"),
                    }
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(
        outcomes.iter().filter(|o| *o == "held").count(),
        6,
        "{outcomes:?}"
    );
    let refused: std::collections::BTreeSet<&String> =
        outcomes.iter().filter(|o| *o != "held").collect();
    assert_eq!(
        refused.into_iter().collect::<Vec<_>>(),
        vec!["agents.team.allocation_exceeded"]
    );
    assert!(w.held() <= parse_amount("2").unwrap());
}

// ---- runs.test.ts: held actions

fn role(w: &World, member: &str, role: &str) {
    w.grant(member, role, true, false, 1).unwrap();
}

#[test]
fn held_actions_refuse_the_agents_creator_approving_its_own_by_four_eyes_even_holding_approver() {
    let w = world_or_skip!();
    let agent = w.ana_agent();
    role(&w, ANA, "creator");
    role(&w, ANA, "approver");
    role(&w, BEN, "approver");
    let runs = w.runs();
    let proposed = runs
        .hold(ANA, BUSINESS, &agent, "support.kb.search", 1)
        .unwrap();
    let action = s(proposed.get("action"));
    assert_eq!(action.get("status"), Some(&Json::str("held")));
    assert_eq!(
        action.get("heldBy"),
        Some(&Json::str("agents.approval_required"))
    );
    assert_eq!(action.get("creatorUserId"), Some(&Json::str(ANA)));
    let Some(Json::String(id)) = action.get("id") else {
        panic!()
    };
    assert_eq!(
        code(runs.approve(ANA, BUSINESS, id)),
        "agents.team_four_eyes"
    );
    let after = w.rows(&format!(
        "SELECT status, approved_by FROM agents.team_held_actions WHERE id = '{id}'"
    ));
    assert_eq!(
        (
            after[0].get::<_, String>(0),
            after[0].get::<_, Option<String>>(1)
        ),
        ("held".to_owned(), None)
    );
    let approved = runs.approve(BEN, BUSINESS, id).unwrap();
    assert_eq!(approved.get("replayed"), Some(&Json::Bool(false)));
    assert_eq!(
        s(approved.get("action")).get("status"),
        Some(&Json::str("approved"))
    );
    assert_eq!(
        s(approved.get("action")).get("approvedBy"),
        Some(&Json::str(BEN))
    );
    assert_eq!(
        runs.approve(BEN, BUSINESS, id).unwrap().get("replayed"),
        Some(&Json::Bool(true))
    );
    let err = w
        .db
        .client()
        .execute(
            &format!("UPDATE agents.team_held_actions SET approved_by = '{ANA}' WHERE id = '{id}'"),
            &[],
        )
        .unwrap_err();
    assert_eq!(
        err.as_db_error().and_then(|e| e.constraint()),
        Some("team_held_actions_four_eyes_ck")
    );
}

#[test]
fn held_actions_need_the_creator_role_to_propose_the_approver_role_to_approve_and_only_the_agents_own_tools()
 {
    let w = world_or_skip!();
    let agent = w.ana_agent();
    let runs = w.runs();
    assert_eq!(
        code(runs.hold(ANA, BUSINESS, &agent, "support.kb.search", 1)),
        "agents.team_role_required"
    );
    role(&w, ANA, "creator");
    assert_eq!(
        code(runs.hold(ANA, BUSINESS, &agent, "ledger.transfer", 1)),
        "agents.team_tool_not_declared"
    );
    let proposed = runs
        .hold(ANA, BUSINESS, &agent, "support.kb.search", 1)
        .unwrap();
    assert_eq!(
        runs.hold(ANA, BUSINESS, &agent, "support.kb.search", 1)
            .unwrap()
            .get("replayed"),
        Some(&Json::Bool(true))
    );
    let Some(Json::String(id)) = s(proposed.get("action")).get("id").cloned() else {
        panic!()
    };
    assert_eq!(
        code(runs.approve(BEN, BUSINESS, &id)),
        "agents.team_role_required"
    );
}

// ---- runs.test.ts: a removed member

#[test]
fn a_removed_member_is_refused_at_their_next_run_before_anything_is_held() {
    let w = world_or_skip!();
    role(&w, BEN, "runner");
    w.team.set(|s| s.members = vec![ANA.to_owned()]);
    assert_eq!(
        code(
            w.runs()
                .run(BEN, BUSINESS, BEN_SESSION, "req-removed-1", "TEST")
        ),
        "agents.team_not_member"
    );
    assert_eq!(w.held(), 0);
}

// ---- runs.test.ts: usage

fn window(w: &World, session: &str, window: &str, sealed: bool, charged: &str, tokens: (i64, i64)) {
    w.exec(&format!(
        "INSERT INTO agents.usage_windows (session_id, window_id) VALUES ('{session}', '{window}');
         INSERT INTO agents.usage_records (session_id, window_id, request_id, task, provider_id, model, input_tokens,
                                           output_tokens, input_price_per_million, output_price_per_million)
         VALUES ('{session}', '{window}', 'r-{window}', 'own.run', 'mock', 'mock', {}, {}, 1, 2);",
        tokens.0, tokens.1
    ));
    if sealed {
        w.exec(&format!(
            "UPDATE agents.usage_windows SET sealed_at = now(), charged_amount = {charged},
                    charge_key = 'agents:usage:{session}:{window}'
              WHERE session_id = '{session}' AND window_id = '{window}'"
        ));
    }
}

#[test]
fn usage_totals_sealed_windows_by_member_and_task_for_members_of_the_business_only() {
    let w = world_or_skip!();
    window(&w, ANA_SESSION, "w1", true, "0.000003", (1, 1));
    window(&w, ANA_SESSION, "w2", false, "0", (5, 5));
    window(&w, BEN_SESSION, "w1", true, "0.000005", (1, 2));
    window(&w, OUTSIDER_SESSION, "w1", true, "0.000009", (3, 3));
    let usage = w.runs().usage(OWNER, BUSINESS).unwrap();
    assert_eq!(strs(&s(usage.get("members"))), vec![OWNER, ANA, BEN]);
    assert_eq!(
        member(&usage, ANA),
        &j(&format!(
            r#"{{"userId":"{ANA}","windows":1,"sealedTotal":"0.000003","tasks":[{{"task":"own.run","inputTokens":1,"outputTokens":1,"cost":"0.000003"}}]}}"#
        ))
    );
    assert_eq!(
        member(&usage, BEN).get("sealedTotal"),
        Some(&Json::str("0.000005"))
    );
    assert_eq!(usage.get("sealedTotal"), Some(&Json::str("0.000008")));
}

#[test]
fn usage_needs_the_spend_reader_role_unless_the_asker_is_a_business_admin() {
    let w = world_or_skip!();
    assert_eq!(
        code(w.runs().usage(ANA, BUSINESS)),
        "agents.team_role_required"
    );
    role(&w, ANA, "spend_reader");
    assert_eq!(
        w.runs().usage(ANA, BUSINESS).unwrap().get("sealedTotal"),
        Some(&Json::str("0"))
    );
    assert_eq!(
        code(w.runs().usage(OUTSIDER, BUSINESS)),
        "agents.team_not_member"
    );
}

// ---- team.runs.open and team.runs.close (routes.ts, runs.ts): no session until the agent's caps are set

#[test]
fn a_run_session_opens_only_with_the_runner_role_and_the_agents_caps_set_and_closes_once() {
    let w = world_or_skip!();
    let agent = w.ana_agent();
    let runs = w.runs();
    assert_eq!(
        code(runs.open(ANA, BUSINESS, &agent)),
        "agents.team_role_required"
    );
    role(&w, ANA, "runner");
    assert_eq!(
        code(runs.open(ANA, BUSINESS, OUTSIDER_SESSION)),
        "agents.team_agent_not_found"
    );
    let sessions = || w.rows("SELECT 1 FROM agents.agent_sessions").len();
    let before = sessions();
    assert_eq!(
        code(runs.open(ANA, BUSINESS, &agent)),
        "agents.spend.cap_unset"
    );
    assert_eq!(
        sessions(),
        before,
        "no session is made while the caps are unset"
    );
    w.exec(&format!(
        "UPDATE agents.own_agents SET per_session_cap = 1 WHERE id = '{agent}';
         INSERT INTO agents.own_agent_limits (owner_id, agent_id, per_call, per_session, per_period, period)
         VALUES ('{ANA}', '{agent}', 0.5, 1, 5, 'month');"
    ));
    let opened = runs.open(ANA, BUSINESS, &agent).unwrap();
    assert_eq!(opened.get("agentId"), Some(&Json::str(agent.clone())));
    assert_eq!(opened.get("businessId"), Some(&Json::str(BUSINESS)));
    let Some(Json::String(session)) = opened.get("sessionId").cloned() else {
        panic!()
    };
    let linked = w.rows(&format!(
        "SELECT s.agent_id, t.member_user_id, t.own_agent_id FROM agents.agent_sessions s
           JOIN agents.team_sessions t ON t.session_id = s.id WHERE s.id = '{session}'"
    ));
    assert_eq!(
        (
            linked[0].get::<_, String>(0),
            linked[0].get::<_, String>(1),
            linked[0].get::<_, String>(2)
        ),
        (format!("own.{agent}"), ANA.to_owned(), agent.clone())
    );
    // Only the member's own team session closes.
    assert_eq!(
        code(runs.close(BEN, &session)),
        "agents.team_session_not_found"
    );
    let closed = runs.close(ANA, &session).unwrap();
    assert_eq!(closed.get("status"), Some(&Json::str("closed")));
    assert_eq!(closed.get("sessionId"), Some(&Json::str(session.clone())));
    let status: String = w.rows(&format!(
        "SELECT status::text FROM agents.agent_sessions WHERE id = '{session}'"
    ))[0]
        .get(0);
    assert_eq!(status, "closed");
}
