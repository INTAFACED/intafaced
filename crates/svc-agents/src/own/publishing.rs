//! Publishing and deleting a person's own agent (`own/publishing.ts`: `checkSurfaces`, `publication`, `publish`,
//! `deleteDraft`). Publishing copies the agent as it stands into `own_agent_versions`, which nothing changes after, and
//! points each chosen surface at that version; a surface not chosen keeps the version it carried. A session keeps the
//! version it opened on (`agent_sessions.guardrail_version`). Nothing here moves value.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::catalog::protection_findings;
use super::evals::in_transaction;
use super::store::is_uuid;
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `OWN_AGENT_SURFACES`.
pub const OWN_AGENT_SURFACES: [&str; 3] = ["my_agents", "chat", "public_catalogue"];

/// `OWN_AGENT_DELETE_CONFIRMATION`.
pub const OWN_AGENT_DELETE_CONFIRMATION: &str = "delete for good";

/// `OWN_SURFACE_POLICY`: the refusal a surface the policy forbids for a person's own agent carries.
pub fn forbidden_code(surface: &str) -> Option<&'static str> {
    (surface == "public_catalogue").then_some("agents.own.surface_not_reviewed")
}

/// `OWN_AGENT_CHILD_TABLES`: every table that holds rows of one own agent, in the order a delete removes them.
pub const OWN_AGENT_CHILD_TABLES: [&str; 27] = [
    "own_agent_tokens",
    "own_agent_session_versions",
    "own_agent_surfaces",
    "own_agent_versions",
    "own_agent_co_owners",
    "own_agent_limits",
    "own_agent_usage_alerts",
    "own_agent_usage_limits",
    "own_agent_payment_methods",
    "own_agent_reviews",
    "own_agent_reviewer_settings",
    "own_agent_approval_requests",
    "own_agent_rules",
    "own_agent_policy_rules",
    "own_agent_policy_settings",
    "own_agent_account_access",
    "own_agent_consents",
    "own_agent_test_runs",
    "own_agent_eval_runs",
    "own_agent_eval_cases",
    "own_agent_background_runs",
    "own_agent_trigger_deliveries",
    "own_agent_auto_runs",
    "own_agent_triggers",
    "own_agent_schedules",
    "own_agent_memory",
    "own_agent_data_controls",
];

/// `checkSurfaces`: unknown or forbidden refuses, and nothing is published; a surface named twice is chosen once.
pub fn check_surfaces(names: &[&str]) -> Result<Vec<&'static str>, OwnRefusal> {
    let mut chosen: Vec<&'static str> = Vec::new();
    for name in names {
        let Some(surface) = OWN_AGENT_SURFACES.iter().find(|s| *s == name) else {
            return Err(OwnRefusal::with(
                "agents.own.surface_unknown",
                [("surface", (*name).to_owned())],
            ));
        };
        if let Some(code) = forbidden_code(surface) {
            return Err(OwnRefusal::with(code, [("surface", (*surface).to_owned())]));
        }
        if !chosen.contains(surface) {
            chosen.push(surface);
        }
    }
    Ok(chosen)
}

/// `publication`: the agent's published versions (oldest first), the version each surface carries and the version each
/// open session runs on, in `ownAgentPublicationSchema`'s order.
pub fn publication(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    session_agent_id: &str,
) -> Result<Json, OwnError> {
    let (agent, versions, surfaces, sessions) = db::with_client(pool, |c| {
        let agent = c.query(
            "SELECT id::text, version, state FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
            &[&owner_id, &agent_id],
        )?;
        let versions = c.query(
            &format!(
                "SELECT version, name, instructions, tools::text, per_session_cap::text, {}
                   FROM agents.own_agent_versions WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY version",
                ms("published_at")
            ),
            &[&owner_id, &agent_id],
        )?;
        let surfaces = c.query(
            "SELECT surface, version FROM agents.own_agent_surfaces WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
            &[&owner_id, &agent_id],
        )?;
        let sessions = c.query(
            "SELECT id::text, guardrail_version FROM agents.agent_sessions
              WHERE user_id = $1::text AND agent_id = $2::text AND status = 'open'
              ORDER BY opened_at, id",
            &[&owner_id, &session_agent_id],
        )?;
        Ok((agent, versions, surfaces, sessions))
    })?;
    let Some(agent) = agent.first() else {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    };
    let versions = versions
        .iter()
        .map(|r| {
            let tools_text: String = r.try_get(3)?;
            let tools =
                service_kit::json::parse(&tools_text).map_err(|e| OwnError::Thrown(e.message))?;
            let cap: Option<String> = r.try_get(4)?;
            let cap = cap
                .map(|c| parse_amount(&c).map(format_amount))
                .transpose()
                .map_err(OwnError::Thrown)?;
            Ok(Json::obj([
                ("version", Json::int(i64::from(r.try_get::<_, i32>(0)?))),
                ("name", Json::str(r.try_get::<_, String>(1)?)),
                ("instructions", Json::str(r.try_get::<_, String>(2)?)),
                ("tools", tools),
                ("perSessionCap", cap.map_or(Json::Null, Json::str)),
                ("publishedAt", Json::str(Instant(r.try_get(5)?).iso())),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    let carried = surfaces
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<_, String>(0)?,
                i64::from(r.try_get::<_, i32>(1)?),
            ))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    let surfaces = OWN_AGENT_SURFACES
        .iter()
        .map(|surface| {
            let forbidden = forbidden_code(surface);
            Json::obj([
                ("surface", Json::str(*surface)),
                ("allowed", Json::Bool(forbidden.is_none())),
                ("forbiddenCode", forbidden.map_or(Json::Null, Json::str)),
                (
                    "version",
                    carried
                        .iter()
                        .find(|(s, _)| s == surface)
                        .map_or(Json::Null, |(_, v)| Json::int(*v)),
                ),
            ])
        })
        .collect();
    let sessions = sessions
        .iter()
        .map(|r| {
            Ok(Json::obj([
                ("sessionId", Json::str(r.try_get::<_, String>(0)?)),
                ("version", Json::int(i64::from(r.try_get::<_, i32>(1)?))),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    Ok(Json::obj([
        ("id", Json::str(agent.try_get::<_, String>(0)?)),
        ("version", Json::int(i64::from(agent.try_get::<_, i32>(1)?))),
        ("state", Json::str(agent.try_get::<_, String>(2)?)),
        ("versions", Json::Array(versions)),
        ("surfaces", Json::Array(surfaces)),
        ("openSessions", Json::Array(sessions)),
    ]))
}

/// `publish`: the agent's current version to the chosen surfaces. A draft is copied as its version first; a finding
/// that blocks publishing, read from the locked row, refuses with nothing published.
pub fn publish(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    surfaces: &[&str],
) -> Result<(), OwnError> {
    if !is_uuid(agent_id) {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    in_transaction(pool, |tx| {
        let rows = tx.query(
            "SELECT id::text, version, state, name, per_session_cap::text FROM agents.own_agents
              WHERE owner_id = $1::text AND id = $2::text::uuid FOR UPDATE",
            &[&owner_id, &agent_id],
        )?;
        let Some(agent) = rows.first() else {
            return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
        };
        let version: i32 = agent.try_get(1)?;
        let state: String = agent.try_get(2)?;
        let name: String = agent.try_get(3)?;
        let cap: Option<String> = agent.try_get(4)?;
        // Every finding blocks publishing.
        if let Some(code) = protection_findings(&name, cap.as_deref()).first() {
            return Ok(Err(OwnRefusal::new(code).into()));
        }
        if state == "draft" {
            tx.execute(
                "INSERT INTO agents.own_agent_versions (agent_id, owner_id, version, name, instructions, tools, per_session_cap)
                 SELECT id, owner_id, version, name, instructions, tools, per_session_cap
                   FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
                &[&owner_id, &agent_id],
            )?;
            tx.execute(
                "UPDATE agents.own_agents SET state = 'published', updated_at = now()
                  WHERE owner_id = $1::text AND id = $2::text::uuid",
                &[&owner_id, &agent_id],
            )?;
        }
        for surface in surfaces {
            tx.execute(
                "INSERT INTO agents.own_agent_surfaces (agent_id, owner_id, surface, version)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::int)
                 ON CONFLICT (agent_id, surface) DO UPDATE SET version = EXCLUDED.version, updated_at = now()",
                &[&agent_id, &owner_id, surface, &version],
            )?;
        }
        Ok(Ok(()))
    })
}

/// `deleteDraft`: only with the person's confirmation. A published agent, or one that has opened a session, is refused
/// and kept whole.
pub fn delete_draft(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    session_agent_id: &str,
    confirm: &str,
) -> Result<(), OwnError> {
    if confirm != OWN_AGENT_DELETE_CONFIRMATION {
        return Err(OwnRefusal::new("agents.own.delete_unconfirmed").into());
    }
    if !is_uuid(agent_id) {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    in_transaction(pool, |tx| {
        let rows = tx.query(
            "SELECT id::text, version, state FROM agents.own_agents
              WHERE owner_id = $1::text AND id = $2::text::uuid FOR UPDATE",
            &[&owner_id, &agent_id],
        )?;
        let Some(agent) = rows.first() else {
            return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
        };
        let state: String = agent.try_get(2)?;
        let published: i32 = tx
            .query_one(
                "SELECT count(*)::int FROM agents.own_agent_versions WHERE agent_id = $1::text::uuid",
                &[&agent_id],
            )?
            .try_get(0)?;
        if state == "published" || published > 0 {
            return Ok(Err(OwnRefusal::new("agents.own.delete_published").into()));
        }
        let sessions: i32 = tx
            .query_one(
                "SELECT count(*)::int FROM agents.agent_sessions WHERE user_id = $1::text AND agent_id = $2::text",
                &[&owner_id, &session_agent_id],
            )?
            .try_get(0)?;
        if sessions > 0 {
            return Ok(Err(OwnRefusal::new("agents.own.delete_has_sessions").into()));
        }
        // Some children key the agent as uuid and some as text; both hold its canonical text.
        for table in OWN_AGENT_CHILD_TABLES {
            tx.execute(
                &format!("DELETE FROM \"agents\".\"{table}\" WHERE agent_id::text = $1::text"),
                &[&agent_id],
            )?;
        }
        tx.execute(
            "DELETE FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
            &[&owner_id, &agent_id],
        )?;
        Ok(Ok(()))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn a_forbidden_surface_is_refused_with_its_reason_and_an_unknown_one_is_unknown() {
        assert_eq!(
            check_surfaces(&["my_agents", "chat", "my_agents"]).unwrap(),
            ["my_agents", "chat"]
        );
        assert_eq!(
            check_surfaces(&["public_catalogue"]).unwrap_err().code,
            "agents.own.surface_not_reviewed"
        );
        assert_eq!(
            check_surfaces(&["my_agents", "public_catalogue"])
                .unwrap_err()
                .code,
            "agents.own.surface_not_reviewed"
        );
        assert_eq!(
            check_surfaces(&["billboard"]).unwrap_err().code,
            "agents.own.surface_unknown"
        );
    }

    /// `a delete removes the rows of every table that refers to an own agent`, over the crate's own migrations.
    #[test]
    fn a_delete_removes_the_rows_of_every_table_that_refers_to_an_own_agent() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut referring = Vec::new();
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                let n = p.to_string_lossy();
                n.ends_with(".sql") && !n.ends_with(".down.sql")
            })
            .collect();
        files.sort();
        for file in files {
            let text = std::fs::read_to_string(file).unwrap();
            for chunk in text
                .split("CREATE TABLE IF NOT EXISTS \"agents\".\"")
                .skip(1)
            {
                let Some((name, rest)) = chunk.split_once("\" (") else {
                    continue;
                };
                let body = rest.split("\n);").next().unwrap_or("");
                if body.contains("REFERENCES \"agents\".\"own_agents\"")
                    && !referring.contains(&name.to_owned())
                {
                    referring.push(name.to_owned());
                }
            }
        }
        referring.sort();
        let mut expected: Vec<String> = OWN_AGENT_CHILD_TABLES
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        expected.sort();
        assert_eq!(referring, expected);
    }
}
