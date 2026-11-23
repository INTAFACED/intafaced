//! A business team's runs, held actions and usage (`team/runs.ts`, `TeamRuns`). Each call reads the team from svc-bank
//! first, so a member removed from the business is refused at their next call, and checks the team role the call
//! needs as it stands now (deny wins). A run is a run of the member's own agent: metered per usage window, owed by the
//! business on that window's key, naming the member, and collected from the business's payment method (on the
//! custodial layer, charged to the member's own account); the business pool only limits it (`runtime/holds.rs`).

use postgres::IsolationLevel;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount};
use service_kit::pg::Pool;

use super::membership::TeamMembership;
use super::store::{
    TeamRead, amount_of, assert_member, effective_roles, lock_business, read_team, require_role,
    stale,
};
use super::{TeamFail, TeamTx, team_error};
use crate::db;
use crate::gateway::providers::{ChatMessage, Role};
use crate::metering::pricing::{ModelPrice, UsageGroup, window_cost};
use crate::runtime::funds::is_uuid;
use crate::runtime::guardrails::{Guardrail, SessionState, evaluate_tool_call};
use crate::runtime::holds::read_own_caps;
use crate::runtime::{self, Rt, ThinkInput};

/// `TEAM_RUN_KEY_PREFIX` (`team/hold.ts`): a team session's holds carry it; only the team run route makes them.
pub const TEAM_RUN_KEY_PREFIX: &str = "team:";

pub use crate::own::OWN_RUN_TASK;

/// `OwnAgentView`, as far as a team run reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnAgent {
    pub id: String,
    pub instructions: String,
    pub tools: Vec<String>,
    /// Canonical, or none when unset.
    pub per_session_cap: Option<String>,
    pub version: i64,
}

/// `ownGuardrail` (`own/routes.ts`), the own agents' one (`own::tool_try::own_guardrail_of`).
pub fn own_guardrail(agent: &OwnAgent) -> Result<Guardrail, TeamFail> {
    crate::own::tool_try::own_guardrail_of(
        &agent.id,
        agent.version,
        &agent.tools,
        agent.per_session_cap.as_deref(),
    )
    .map_err(TeamFail::Thrown)
}

/// `OwnAgentStore.get`: the person's own agent, or none (any other person's agent reads as none).
pub fn own_agent(pool: &Pool, owner_id: &str, id: &str) -> Result<Option<OwnAgent>, TeamFail> {
    if !is_uuid(id) {
        return Ok(None);
    }
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT id::text, instructions, tools::text, per_session_cap::text, version
               FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
            &[&owner_id, &id],
        )?)
    })?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let tools_text: String = r.try_get(2)?;
    let tools = match json::parse(&tools_text).map_err(|e| TeamFail::Thrown(e.message))? {
        Json::Array(items) => items
            .into_iter()
            .filter_map(|t| match t {
                Json::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let cap: Option<String> = r.try_get(3)?;
    Ok(Some(OwnAgent {
        id: r.try_get(0)?,
        instructions: r.try_get(1)?,
        tools,
        per_session_cap: cap.map(|c| amount_of(&c).map(format_amount)).transpose()?,
        version: i64::from(r.try_get::<_, i32>(4)?),
    }))
}

/// `TeamRuns`.
pub struct TeamRuns<'a> {
    pub x: Rt<'a>,
    pub membership: &'a dyn TeamMembership,
    /// Trimmed and set: `runsOf` refuses a blank one first.
    pub fee_asset_id: &'a str,
}

/// `heldView`.
fn held_view(r: &postgres::Row) -> Result<Json, postgres::Error> {
    let approved_by: Option<String> = r.try_get(6)?;
    Ok(Json::obj([
        ("id", Json::str(r.try_get::<_, String>(0)?)),
        ("seq", Json::int(i64::from(r.try_get::<_, i32>(1)?))),
        ("agentId", Json::str(r.try_get::<_, String>(2)?)),
        ("creatorUserId", Json::str(r.try_get::<_, String>(3)?)),
        ("tool", Json::str(r.try_get::<_, String>(4)?)),
        ("heldBy", Json::str("agents.approval_required")),
        ("status", Json::str(r.try_get::<_, String>(5)?)),
        ("approvedBy", approved_by.map_or(Json::Null, Json::str)),
    ]))
}

const HELD_COLUMNS: &str =
    "id::text, seq, own_agent_id, creator_user_id, tool, status, approved_by";

fn result(action: Json, replayed: bool) -> Json {
    Json::obj([("action", action), ("replayed", Json::Bool(replayed))])
}

fn session_not_found() -> TeamFail {
    team_error(
        "agents.team_session_not_found",
        "No such team session of yours",
    )
    .into()
}

impl TeamRuns<'_> {
    fn pool(&self) -> &Pool {
        self.x.pool
    }

    fn team(&self, user_id: &str, business_id: &str) -> Result<TeamRead, TeamFail> {
        Ok(read_team(self.membership, user_id, business_id)?)
    }

    /// The member's own agent; any other is one answer, so no oracle for others' agents.
    fn own(&self, user_id: &str, agent_id: &str) -> Result<OwnAgent, TeamFail> {
        own_agent(self.pool(), user_id, agent_id)?.ok_or_else(|| {
            team_error("agents.team_agent_not_found", "No such agent of yours").into()
        })
    }

    /// `open`: a run session of one of the member's own agents on the business pool. Needs the runner role. Refused,
    /// with no session made, until the agent's own caps are set: nothing runs uncapped.
    pub fn open(&self, user_id: &str, business_id: &str, agent_id: &str) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        require_role(self.pool(), &team, user_id, "runner")?;
        let agent = self.own(user_id, agent_id)?;
        let caps = db::with_client(self.pool(), |c| read_own_caps(c, user_id, &agent.id))?;
        if caps.is_none() {
            return Err(TeamFail::Own("agents.spend.cap_unset"));
        }
        let session = runtime::open_own_session(&self.x, user_id, &own_guardrail(&agent)?)?;
        let linked = db::with_client(self.pool(), |c| {
            c.execute(
                "INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4::text)",
                &[&session.id, &team.business_id, &user_id, &agent.id],
            )?;
            Ok(())
        });
        if let Err(e) = linked {
            // A session the team cannot be linked to is closed at once (nothing ran on it), so no open session is
            // left outside the team's hold; the member's retry opens a fresh one.
            let _ = runtime::close_settled(&self.x, &session.id);
            return Err(e.into());
        }
        Ok(Json::obj([
            ("sessionId", Json::str(session.id)),
            ("agentId", Json::str(agent.id)),
            ("businessId", Json::str(team.business_id)),
        ]))
    }

    /// `run`: one run on a team session, as the member asks it now: still on the business and still a runner.
    pub fn run(
        &self,
        user_id: &str,
        business_id: &str,
        session_id: &str,
        request_id: &str,
        ask: &str,
    ) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        require_role(self.pool(), &team, user_id, "runner")?;
        let rows = db::with_client(self.pool(), |c| {
            Ok(c.query(
                "SELECT own_agent_id FROM agents.team_sessions
                  WHERE session_id = $1::text::uuid AND business_id = $2::text::uuid AND member_user_id = $3::text",
                &[&session_id, &team.business_id, &user_id],
            )?)
        })?;
        let Some(row) = rows.first() else {
            return Err(session_not_found());
        };
        let own_agent_id: String = row.try_get(0)?;
        let agent = self.own(user_id, &own_agent_id)?;
        let messages = [ChatMessage {
            role: Role::User,
            content: ask.to_owned(),
        }];
        let instructions = agent.instructions.trim();
        let result = runtime::think(
            &self.x,
            &ThinkInput {
                session_id,
                request_id: &format!("{TEAM_RUN_KEY_PREFIX}{request_id}"),
                task: OWN_RUN_TASK,
                system: (!instructions.is_empty()).then_some(agent.instructions.as_str()),
                messages: &messages,
                max_output_tokens: None,
                team_run: true,
            },
        )?;
        Ok(Json::obj([
            ("text", Json::str(result.text)),
            ("cost", Json::str(format_amount(result.cost))),
            ("assetId", Json::str(self.fee_asset_id)),
            ("inputTokens", Json::int(result.usage.input_tokens)),
            ("outputTokens", Json::int(result.usage.output_tokens)),
        ]))
    }

    /// `close`: the member's team session closed once its windows are settled, each owed by the business on its own
    /// key. Settling what was already used does not wait on membership: a member removed since still pays what they ran.
    pub fn close(&self, user_id: &str, session_id: &str) -> Result<Json, TeamFail> {
        let rows = db::with_client(self.pool(), |c| {
            Ok(c.query(
                "SELECT session_id::text FROM agents.team_sessions
                  WHERE session_id = $1::text::uuid AND member_user_id = $2::text",
                &[&session_id, &user_id],
            )?)
        })?;
        if rows.is_empty() {
            return Err(session_not_found());
        }
        let closed = runtime::close_settled(&self.x, session_id)?;
        Ok(Json::obj([
            ("sessionId", Json::str(closed.id)),
            ("status", Json::str("closed")),
            (
                "closedAt",
                Json::str(closed.closed_at.unwrap_or(self.x.now).iso()),
            ),
        ]))
    }

    /// `hold`: a tool action of the member's own agent proposed for the team. Its guardrail holds it
    /// (`agents.approval_required`) until an approver who is not its creator approves it. Needs the creator role. Held
    /// action `seq` of the business has the key `agents:hold:<business>:<seq>`; the same proposal again is a replay,
    /// any other with a used number stale.
    pub fn hold(
        &self,
        user_id: &str,
        business_id: &str,
        agent_id: &str,
        tool: &str,
        seq: i64,
    ) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        require_role(self.pool(), &team, user_id, "creator")?;
        let agent = self.own(user_id, agent_id)?;
        // On a team, every tool of an agent asks for approval before it runs.
        let mut guardrail = own_guardrail(&agent)?;
        for t in &mut guardrail.tools {
            t.requires_approval = true;
        }
        let empty = SessionState {
            closed: false,
            action_count: 0,
            tool_calls: Vec::new(),
            spend: 0,
            approved_tools: Vec::new(),
        };
        match evaluate_tool_call(&guardrail, &empty, tool, None, None) {
            Err(r) if r.code == "agents.approval_required" => {}
            _ => {
                return Err(team_error(
                    "agents.team_tool_not_declared",
                    format!("{tool} is not one of this agent's tools"),
                )
                .into());
            }
        }
        let b = team.business_id.as_str();
        let key = format!("agents:hold:{b}:{seq}");
        let seq = i32::try_from(seq).map_err(|e| TeamFail::Thrown(e.to_string()))?;
        let out = db::transaction_retrying(self.pool(), IsolationLevel::Serializable, 5, |tx| {
            lock_business(tx, b)?;
            let same = tx.query(
                &format!("SELECT {HELD_COLUMNS} FROM agents.team_held_actions WHERE idempotency_key = $1::text"),
                &[&key],
            )?;
            if let Some(r) = same.first() {
                let (own, creator, held_tool): (String, String, String) =
                    (r.try_get(2)?, r.try_get(3)?, r.try_get(4)?);
                if own != agent.id || creator != user_id || held_tool != tool {
                    return Err(TeamTx::from(stale()));
                }
                return Ok(result(held_view(r)?, true));
            }
            let last: i32 = tx
                .query_one(
                    "SELECT COALESCE(MAX(seq), 0)::int FROM agents.team_held_actions WHERE business_id = $1::text::uuid",
                    &[&b],
                )?
                .try_get(0)?;
            if seq != last + 1 {
                return Err(stale().into());
            }
            let row = tx.query_one(
                &format!(
                    "INSERT INTO agents.team_held_actions (id, business_id, own_agent_id, creator_user_id, tool, seq, idempotency_key)
                     VALUES (gen_random_uuid(), $1::text::uuid, $2::text, $3::text, $4::text, $5, $6::text)
                     RETURNING {HELD_COLUMNS}"
                ),
                &[&b, &agent.id, &user_id, &tool, &seq, &key],
            )?;
            Ok(result(held_view(&row)?, false))
        })?;
        Ok(out)
    }

    /// `approve`: a held action approved. Needs the approver role, and four eyes: the agent's creator is refused
    /// `agents.team_four_eyes` even when they also hold approver. Approving again as the same approver is a replay.
    pub fn approve(
        &self,
        user_id: &str,
        business_id: &str,
        action_id: &str,
    ) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        require_role(self.pool(), &team, user_id, "approver")?;
        let b = team.business_id.as_str();
        let out = db::transaction_retrying(self.pool(), IsolationLevel::Serializable, 5, |tx| {
            lock_business(tx, b)?;
            let rows = tx.query(
                &format!(
                    "SELECT {HELD_COLUMNS} FROM agents.team_held_actions
                      WHERE id = $1::text::uuid AND business_id = $2::text::uuid"
                ),
                &[&action_id, &b],
            )?;
            let Some(r) = rows.first() else {
                return Err(TeamTx::from(team_error(
                    "agents.team_action_not_found",
                    "No such held action",
                )));
            };
            let creator: String = r.try_get(3)?;
            if creator == user_id {
                return Err(team_error(
                    "agents.team_four_eyes",
                    "The agent's creator cannot approve its own action",
                )
                .into());
            }
            let status: String = r.try_get(5)?;
            if status == "approved" {
                let approved_by: Option<String> = r.try_get(6)?;
                if approved_by.as_deref() == Some(user_id) {
                    return Ok(result(held_view(r)?, true));
                }
                return Err(team_error(
                    "agents.team_action_closed",
                    "Already approved by someone else",
                )
                .into());
            }
            let id: String = r.try_get(0)?;
            let next = tx.query_one(
                &format!(
                    "UPDATE agents.team_held_actions SET status = 'approved', approved_by = $2::text, approved_at = now()
                      WHERE id = $1::text::uuid AND status = 'held'
                     RETURNING {HELD_COLUMNS}"
                ),
                &[&id, &user_id],
            )?;
            Ok(result(held_view(&next)?, false))
        })?;
        Ok(out)
    }

    /// `actions`: the business's held actions, newest first, to any current member.
    pub fn actions(&self, user_id: &str, business_id: &str, limit: i64) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        let rows = db::with_client(self.pool(), |c| {
            Ok(c.query(
                &format!(
                    "SELECT {HELD_COLUMNS} FROM agents.team_held_actions
                      WHERE business_id = $1::text::uuid ORDER BY seq DESC LIMIT $2"
                ),
                &[&team.business_id, &limit],
            )?)
        })?;
        Ok(Json::Array(
            rows.iter().map(held_view).collect::<Result<Vec<_>, _>>()?,
        ))
    }

    /// `usage`: usage by member and task from sealed windows of the business's team sessions, for current members only.
    /// Needs the spend reader role, or a business admin. A window still open is not counted.
    pub fn usage(&self, user_id: &str, business_id: &str) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        assert_member(&team, user_id)?;
        if !team.can_manage()
            && !effective_roles(self.pool(), &team.business_id, user_id)?.contains(&"spend_reader")
        {
            return Err(team_error(
                "agents.team_role_required",
                "This needs the spend_reader team role",
            )
            .into());
        }
        let ids = Json::Array(
            team.members
                .iter()
                .map(|m| Json::str(m.user_id.clone()))
                .collect(),
        )
        .compact();
        let b = team.business_id.as_str();
        let (windows, records) = db::with_client(self.pool(), |c| {
            let windows = c.query(
                "SELECT t.member_user_id, w.session_id::text, w.window_id, w.charged_amount::text, w.charge_key,
                        w.charge_tx_id, w.paid_by, w.payment_ref, w.payment_label, w.owed_by_business
                   FROM agents.usage_windows w
                   JOIN agents.team_sessions t ON t.session_id = w.session_id
                  WHERE t.business_id = $1::text::uuid
                    AND t.member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))
                    AND w.sealed_at IS NOT NULL
                  ORDER BY w.sealed_at DESC, w.window_id DESC",
                &[&b, &ids],
            )?;
            let records = if windows.is_empty() {
                Vec::new()
            } else {
                c.query(
                    "SELECT r.session_id::text, r.window_id, r.task, r.input_tokens::text, r.output_tokens::text,
                            r.input_price_per_million::text, r.output_price_per_million::text
                       FROM agents.usage_records r
                       JOIN agents.team_sessions t ON t.session_id = r.session_id
                       JOIN agents.usage_windows w ON w.session_id = r.session_id AND w.window_id = r.window_id
                      WHERE t.business_id = $1::text::uuid
                        AND t.member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))
                        AND w.sealed_at IS NOT NULL",
                    &[&b, &ids],
                )?
            };
            Ok((windows, records))
        })?;

        struct W {
            member: String,
            session: String,
            window: String,
            charged: Amount,
            charge_key: Option<String>,
            settled: bool,
            payment: Option<(String, String)>,
            owed_by_business: bool,
        }
        struct R {
            session: String,
            window: String,
            task: String,
            group: UsageGroup,
        }
        let mut ws = Vec::new();
        for r in &windows {
            let paid_by: Option<String> = r.try_get(6)?;
            let payment_ref: Option<String> = r.try_get(7)?;
            let label: Option<String> = r.try_get(8)?;
            ws.push(W {
                member: r.try_get(0)?,
                session: r.try_get(1)?,
                window: r.try_get(2)?,
                charged: amount_of(&r.try_get::<_, String>(3)?)?,
                charge_key: r.try_get(4)?,
                settled: r.try_get::<_, Option<String>>(5)?.is_some(),
                payment: match (paid_by.as_deref(), payment_ref) {
                    (Some("partner"), Some(p)) if !p.is_empty() => {
                        Some((p, label.unwrap_or_default()))
                    }
                    _ => None,
                },
                owed_by_business: r.try_get::<_, Option<String>>(9)?.is_some(),
            });
        }
        let int = |s: String| -> Result<Amount, TeamFail> {
            s.parse::<Amount>()
                .map_err(|e| TeamFail::Thrown(e.to_string()))
        };
        let mut rs = Vec::new();
        for r in &records {
            rs.push(R {
                session: r.try_get(0)?,
                window: r.try_get(1)?,
                task: r.try_get(2)?,
                group: UsageGroup {
                    input_tokens: int(r.try_get(3)?)?,
                    output_tokens: int(r.try_get(4)?)?,
                    price: ModelPrice {
                        input_per_million: amount_of(&r.try_get::<_, String>(5)?)?,
                        output_per_million: amount_of(&r.try_get::<_, String>(6)?)?,
                    },
                },
            });
        }

        let mut business_total: Amount = 0;
        let mut members = Vec::new();
        for m in &team.members {
            let mine: Vec<&W> = ws.iter().filter(|w| w.member == m.user_id).collect();
            let sealed_total: Amount = mine.iter().map(|w| w.charged).sum();
            business_total += sealed_total;
            // (task, input, output, cost), in first-seen order, sorted by task at the end.
            let mut tasks: Vec<(String, Amount, Amount, Amount)> = Vec::new();
            for w in &mine {
                let in_window: Vec<&R> = rs
                    .iter()
                    .filter(|r| r.session == w.session && r.window == w.window)
                    .collect();
                let mut seen: Vec<&str> = Vec::new();
                for r in &in_window {
                    if !seen.contains(&r.task.as_str()) {
                        seen.push(&r.task);
                    }
                }
                for task in seen {
                    let groups: Vec<UsageGroup> = in_window
                        .iter()
                        .filter(|r| r.task == task)
                        .map(|r| r.group)
                        .collect();
                    let cost = window_cost(&groups).map_err(|e| TeamFail::Thrown(e.0))?;
                    let idx = match tasks.iter().position(|t| t.0 == task) {
                        Some(i) => i,
                        None => {
                            tasks.push((task.to_owned(), 0, 0, 0));
                            tasks.len() - 1
                        }
                    };
                    if let Some(sum) = tasks.get_mut(idx) {
                        for g in &groups {
                            sum.1 += g.input_tokens;
                            sum.2 += g.output_tokens;
                        }
                        sum.3 += cost;
                    }
                }
            }
            tasks.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let count = |v: Amount| Json::Number(v as f64);
            members.push(Json::obj([
                ("userId", Json::str(m.user_id.clone())),
                (
                    "windows",
                    Json::int(i64::try_from(mine.len()).unwrap_or(i64::MAX)),
                ),
                ("sealedTotal", Json::str(format_amount(sealed_total))),
                (
                    "tasks",
                    Json::Array(
                        tasks
                            .into_iter()
                            .map(|(task, i, o, cost)| {
                                Json::obj([
                                    ("task", Json::str(task)),
                                    ("inputTokens", count(i)),
                                    ("outputTokens", count(o)),
                                    ("cost", Json::str(format_amount(cost))),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]));
        }
        // A window with nothing billable posts nothing and is owed by no one; it is left out as it charged nothing.
        let windows_view: Vec<Json> = ws
            .iter()
            .filter(|w| w.charged > 0)
            .map(|w| {
                Json::obj([
                    ("userId", Json::str(w.member.clone())),
                    ("sessionId", Json::str(w.session.clone())),
                    ("windowId", Json::str(w.window.clone())),
                    (
                        "chargeKey",
                        w.charge_key.clone().map_or(Json::Null, Json::str),
                    ),
                    ("amount", Json::str(format_amount(w.charged))),
                    (
                        "owedBy",
                        Json::str(if w.owed_by_business {
                            "business"
                        } else {
                            "member"
                        }),
                    ),
                    (
                        "state",
                        Json::str(if w.settled { "settled" } else { "owed" }),
                    ),
                    (
                        "payment",
                        w.payment.as_ref().map_or(Json::Null, |(r, l)| {
                            Json::obj([
                                ("ref", Json::str(r.clone())),
                                ("label", Json::str(l.clone())),
                            ])
                        }),
                    ),
                ])
            })
            .collect();
        Ok(Json::obj([
            ("businessId", Json::str(team.business_id.clone())),
            ("assetId", Json::str(self.fee_asset_id)),
            ("members", Json::Array(members)),
            ("sealedTotal", Json::str(format_amount(business_total))),
            ("windows", Json::Array(windows_view)),
        ]))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_grantable_tools_are_the_catalogs_non_money_tools_with_a_shape() {
        // Each tool an own guardrail may grant has a shape and is not a money tool; `pay.metrics.read` (no shape) and the
        // money tools are not grantable, and every other catalogue tool is.
        let tools = crate::own::catalog::own_tools();
        let grantable: Vec<_> = tools
            .iter()
            .filter(|t| !t.moves_money && t.shape.is_some())
            .collect();
        let pay = tools.iter().find(|t| t.name == "pay.metrics.read").unwrap();
        assert!(pay.shape.is_none() && !pay.moves_money);
        assert!(!grantable.iter().any(|t| t.name == "pay.metrics.read"));
        assert_eq!(
            grantable.len() + 1,
            tools.iter().filter(|t| !t.moves_money).count(),
            "every non-money tool but pay.metrics.read is grantable"
        );
        for t in &grantable {
            assert_eq!(t.data_class == Some("live_write"), t.writes(), "{}", t.name);
        }
    }

    fn agent(tools: &[&str], cap: Option<&str>) -> OwnAgent {
        OwnAgent {
            id: "a1b2c3d4-0000-4000-8000-000000000001".to_owned(),
            instructions: String::new(),
            tools: tools.iter().map(|t| (*t).to_owned()).collect(),
            per_session_cap: cap.map(str::to_owned),
            version: 3,
        }
    }

    #[test]
    fn an_own_guardrail_grants_the_saved_tools_in_their_modules_and_holds_every_write() {
        let g = own_guardrail(&agent(
            &[
                "support.kb.search",
                "support.ticket.comment",
                "ledger.transfer",
                "pay.metrics.read",
            ],
            Some("2"),
        ))
        .unwrap();
        assert_eq!(g.agent_id, "own.a1b2c3d4-0000-4000-8000-000000000001");
        assert_eq!(g.version, 3);
        let tools: Vec<(&str, &str, bool)> = g
            .tools
            .iter()
            .map(|t| (t.name.as_str(), t.mode.as_str(), t.requires_approval))
            .collect();
        assert_eq!(
            tools,
            vec![
                ("support.kb.search", "read", false),
                ("support.ticket.comment", "write", true)
            ]
        );
        assert_eq!(g.limits.allowed_modules, vec!["support".to_owned()]);
        assert_eq!(g.limits.allowed_tasks, vec![OWN_RUN_TASK.to_owned()]);
        assert_eq!(g.limits.max_actions_per_session, 60);
        assert_eq!(g.limits.max_output_tokens_per_call, 2048);
        assert!(g.limits.max_spend_per_session.is_some());
        assert!(
            own_guardrail(&agent(&[], None))
                .unwrap()
                .limits
                .max_spend_per_session
                .is_none()
        );
    }
}
