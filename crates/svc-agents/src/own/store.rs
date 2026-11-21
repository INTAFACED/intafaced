//! A person's own agents (`services/svc-agents/src/own/store.ts`, `OwnAgentStore`). Every read and write is scoped to
//! the owner, so an id that belongs to someone else reads as not found. Nothing here moves value.

use postgres::IsolationLevel;
use postgres::types::ToSql;

use service_kit::json::{self, Json};
use service_kit::money::{format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::catalog::{
    DraftInput, OWN_AGENTS_MAX, findings_json, protection_findings, template_tools, validate_draft,
};
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `OwnAgentView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnAgent {
    pub id: String,
    pub template: String,
    pub name: String,
    pub instructions: String,
    pub tools: Vec<String>,
    pub per_session_cap: Option<String>,
    pub version: i64,
    pub state: String,
    pub created_at: Instant,
    pub updated_at: Instant,
}

impl OwnAgent {
    /// `protectionFindings` of the stored draft.
    pub fn findings(&self) -> Vec<&'static str> {
        protection_findings(&self.name, self.per_session_cap.as_deref())
    }

    /// `ownAgentSchema`, in its order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("template", Json::str(self.template.clone())),
            ("name", Json::str(self.name.clone())),
            ("instructions", Json::str(self.instructions.clone())),
            (
                "tools",
                Json::Array(self.tools.iter().map(|t| Json::str(t.clone())).collect()),
            ),
            (
                "perSessionCap",
                self.per_session_cap.clone().map_or(Json::Null, Json::str),
            ),
            ("version", Json::int(self.version)),
            ("state", Json::str(self.state.clone())),
            ("findings", findings_json(&self.findings())),
            ("createdAt", Json::str(self.created_at.iso())),
            ("updatedAt", Json::str(self.updated_at.iso())),
        ])
    }
}

/// `UUID_RE`: an id Postgres could not read as a uuid is not found, never a database error.
pub fn is_uuid(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn columns() -> String {
    format!(
        "id::text, template, name, instructions, tools::text, per_session_cap::text, version, state, {}, {}",
        ms("created_at"),
        ms("updated_at")
    )
}

fn agent_of(r: &postgres::Row) -> Result<OwnAgent, OwnError> {
    let tools_text: String = r.try_get(4)?;
    let tools = match json::parse(&tools_text).map_err(|e| OwnError::Thrown(e.message))? {
        Json::Array(items) => items
            .into_iter()
            .filter_map(|t| match t {
                Json::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let cap: Option<String> = r.try_get(5)?;
    let per_session_cap = cap
        .map(|c| parse_amount(&c).map(format_amount))
        .transpose()
        .map_err(OwnError::Thrown)?;
    Ok(OwnAgent {
        id: r.try_get(0)?,
        template: r.try_get(1)?,
        name: r.try_get(2)?,
        instructions: r.try_get(3)?,
        tools,
        per_session_cap,
        version: i64::from(r.try_get::<_, i32>(6)?),
        state: r.try_get(7)?,
        created_at: Instant(r.try_get(8)?),
        updated_at: Instant(r.try_get(9)?),
    })
}

fn tools_json(tools: &[String]) -> String {
    Json::Array(tools.iter().map(|t| Json::str(t.clone())).collect()).compact()
}

/// The insert of `create` and `createDrafted`: one at a time per person, one draft per create key, at most
/// `OWN_AGENTS_MAX`.
fn insert_once(
    pool: &Pool,
    owner_id: &str,
    create_key: &str,
    insert: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<OwnAgent, OwnError> {
    let cols = columns();
    let mut out: Option<Result<OwnAgent, OwnError>> = None;
    db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1::text))",
            &[&format!("agents.own:{owner_id}")],
        )?;
        let existing = tx.query(
            &format!(
                "SELECT {cols} FROM agents.own_agents WHERE owner_id = $1::text AND create_key = $2::text"
            ),
            &[&owner_id, &create_key],
        )?;
        if let Some(r) = existing.first() {
            out = Some(agent_of(r));
            return Ok(());
        }
        let count: i64 = tx
            .query_one(
                "SELECT count(*)::bigint FROM agents.own_agents WHERE owner_id = $1::text",
                &[&owner_id],
            )?
            .try_get(0)?;
        if count >= OWN_AGENTS_MAX {
            out = Some(Err(OwnError::Refusal(OwnRefusal::with(
                "agents.own.too_many",
                [("limit", OWN_AGENTS_MAX.to_string())],
            ))));
            return Ok(());
        }
        let row = tx.query_one(&format!("{insert} RETURNING {cols}"), params)?;
        out = Some(agent_of(&row));
        Ok(())
    })?;
    out.unwrap_or_else(|| {
        Err(OwnError::Thrown(
            "own agent create wrote nothing".to_owned(),
        ))
    })
}

/// `create`: one draft per create key; a retried create returns the draft the first one made.
pub fn create(
    pool: &Pool,
    owner_id: &str,
    template: &str,
    create_key: &str,
) -> Result<OwnAgent, OwnError> {
    let tools: Vec<String> = template_tools(template)
        .iter()
        .map(|t| (*t).to_owned())
        .collect();
    let tools = tools_json(&tools);
    insert_once(
        pool,
        owner_id,
        create_key,
        "INSERT INTO agents.own_agents (owner_id, template, tools, create_key) \
         VALUES ($1::text, $2::text, $3::text::jsonb, $4::text)",
        &[&owner_id, &template, &tools, &create_key],
    )
}

/// `createDrafted`: a draft the person accepted from the assistant, checked by the same validator a save meets.
pub fn create_drafted(
    pool: &Pool,
    owner_id: &str,
    input: &DraftInput<'_>,
    create_key: &str,
) -> Result<OwnAgent, OwnError> {
    let f = validate_draft(input)?;
    let tools = tools_json(&f.tools);
    insert_once(
        pool,
        owner_id,
        create_key,
        "INSERT INTO agents.own_agents (owner_id, template, name, instructions, tools, per_session_cap, create_key) \
         VALUES ($1::text, 'blank', $2::text, $3::text, $4::text::jsonb, $5::text::numeric, $6::text)",
        &[
            &owner_id,
            &f.name,
            &f.instructions,
            &tools,
            &f.per_session_cap,
            &create_key,
        ],
    )
}

/// `save`: a published version never changes; an edit after it is the next version, a draft.
pub fn save(
    pool: &Pool,
    owner_id: &str,
    id: &str,
    input: &DraftInput<'_>,
) -> Result<OwnAgent, OwnError> {
    let f = validate_draft(input)?;
    if !is_uuid(id) {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    let tools = tools_json(&f.tools);
    let unchanged = "(name = $3::text AND instructions = $4::text AND tools = $5::text::jsonb \
                     AND per_session_cap IS NOT DISTINCT FROM $6::text::numeric)";
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "UPDATE agents.own_agents
                    SET name = $3::text,
                        instructions = $4::text,
                        tools = $5::text::jsonb,
                        per_session_cap = $6::text::numeric,
                        version = CASE WHEN state = 'published' AND NOT {unchanged} THEN version + 1 ELSE version END,
                        state = CASE WHEN state = 'published' AND {unchanged} THEN 'published' ELSE 'draft' END,
                        updated_at = now()
                  WHERE owner_id = $1::text AND id = $2::text::uuid
                 RETURNING {}",
                columns()
            ),
            &[&owner_id, &id, &f.name, &f.instructions, &tools, &f.per_session_cap],
        )?)
    })?;
    rows.first()
        .map(agent_of)
        .unwrap_or_else(|| Err(OwnRefusal::new("agents.own.not_found").into()))
}

/// `get`: the person's own agent, or not found.
pub fn get(pool: &Pool, owner_id: &str, id: &str) -> Result<OwnAgent, OwnError> {
    if !is_uuid(id) {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
                columns()
            ),
            &[&owner_id, &id],
        )?)
    })?;
    rows.first()
        .map(agent_of)
        .unwrap_or_else(|| Err(OwnRefusal::new("agents.own.not_found").into()))
}

/// `list`: newest first.
pub fn list(pool: &Pool, owner_id: &str, limit: i64) -> Result<Vec<OwnAgent>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agents WHERE owner_id = $1::text ORDER BY created_at DESC, id LIMIT $2::bigint",
                columns()
            ),
            &[&owner_id, &limit],
        )?)
    })?;
    rows.iter().map(agent_of).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_uuid_is_read_as_an_id() {
        assert!(is_uuid("0a1b2c3d-0000-4000-8000-ABCDEF012345"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("0a1b2c3d-0000-4000-8000-ABCDEF01234"));
        assert!(!is_uuid("0a1b2c3d00000-4000-8000-ABCDEF012345"));
    }
}
