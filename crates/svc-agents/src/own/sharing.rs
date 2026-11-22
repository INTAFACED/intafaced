//! An own agent's co-owners and its share with them (`own/publishing.ts`: `checkCoOwner`, `isGroup`, `coOwners`,
//! `addCoOwner`, `removeCoOwner`, `sharedWith`; `own/memory.ts`: `share`, `shareCheck`, `setShare`; AG-builder-03,
//! AG-guardrails-04, J-agents-03 #8, J-agents-09 #6). A co-owner is one active person, by account id; a group, team or
//! business never is, nor the owner. A share that exposes private context waits for the person's confirmation, and
//! nothing is stored before it. Nothing here moves value.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::desk::{DeskAccount, SupportDesk};
use super::store::is_uuid;
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `GROUP_REFERENCE`: `^(group|team|business|org|organisation|organization):`, any case.
fn is_group_reference(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "group:",
        "team:",
        "business:",
        "org:",
        "organisation:",
        "organization:",
    ]
    .iter()
    .any(|p| lower.starts_with(p))
}

/// `checkCoOwner`: a co-owner is one person, named by their account id; a group is refused, and so is the owner.
pub fn check_co_owner(owner_id: &str, reference: &str) -> Result<String, OwnRefusal> {
    let text = js_trim(reference);
    if is_group_reference(text) {
        return Err(OwnRefusal::new("agents.own.co_owner_group"));
    }
    if !is_uuid(text) {
        return Err(OwnRefusal::new("agents.own.co_owner_invalid"));
    }
    let user_id = text.to_ascii_lowercase();
    if user_id == owner_id.to_lowercase() {
        return Err(OwnRefusal::new("agents.own.co_owner_self"));
    }
    Ok(user_id)
}

/// `isGroup`: whether an id is a group svc-agents knows, a business or one of its projects (AG-governance-01).
pub fn is_group(pool: &Pool, id: &str) -> Result<bool, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT EXISTS (SELECT 1 FROM agents.team_pools WHERE business_id = $1::text::uuid)
                 OR EXISTS (SELECT 1 FROM agents.team_role_grants WHERE business_id = $1::text::uuid)
                 OR EXISTS (SELECT 1 FROM agents.team_projects WHERE id = $1::text::uuid OR business_id = $1::text::uuid) AS hit",
            &[&id],
        )?)
    })?;
    Ok(match rows.first() {
        Some(r) => r.try_get::<_, Option<bool>>(0)? == Some(true),
        None => false,
    })
}

/// The co-owner's account as `own.coOwners.add` asks identity for it: one active person, never added on a guess.
pub fn assert_active_person(
    accounts: Option<&dyn SupportDesk>,
    user_id: &str,
) -> Result<(), OwnRefusal> {
    let read = accounts.map_or(DeskAccount::Unread, |a| a.read_account(user_id));
    let DeskAccount::Ok { status, .. } = read else {
        return Err(OwnRefusal::new("agents.own.co_owner_unread"));
    };
    if status != "active" {
        return Err(OwnRefusal::new("agents.own.co_owner_inactive"));
    }
    Ok(())
}

/// `coOwners`: oldest first, in `ownAgentCoOwnerSchema`'s order.
pub fn co_owners(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT co_owner_id, {} FROM agents.own_agent_co_owners
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY created_at, co_owner_id",
                ms("created_at")
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    let rows = rows
        .iter()
        .map(|r| {
            Ok(Json::obj([
                ("userId", Json::str(r.try_get::<_, String>(0)?)),
                ("addedAt", Json::str(Instant(r.try_get(1)?).iso())),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    Ok(Json::Array(rows))
}

/// `addCoOwner`: one person, once; the same person again is the row already held.
pub fn add_co_owner(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    co_owner_id: &str,
) -> Result<(), OwnError> {
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_co_owners (agent_id, owner_id, co_owner_id)
             VALUES ($1::text::uuid, $2::text, $3::text)
             ON CONFLICT (agent_id, co_owner_id) DO NOTHING",
            &[&agent_id, &owner_id, &co_owner_id],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `removeCoOwner`.
pub fn remove_co_owner(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    co_owner_id: &str,
) -> Result<(), OwnError> {
    db::with_client(pool, |c| {
        c.execute(
            "DELETE FROM agents.own_agent_co_owners
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND co_owner_id = $3::text",
            &[&owner_id, &agent_id, &co_owner_id],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `sharedWith`: other people's agents this person co-owns, newest first, read only.
pub fn shared_with(pool: &Pool, user_id: &str, limit: i64) -> Result<Json, OwnError> {
    let user = user_id.to_lowercase();
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT a.id::text, a.owner_id, a.name, a.version::bigint, a.state::text
               FROM agents.own_agent_co_owners c
               JOIN agents.own_agents a ON a.id = c.agent_id AND a.owner_id = c.owner_id
              WHERE c.co_owner_id = $1::text
              ORDER BY c.created_at DESC, a.id
              LIMIT $2::bigint",
            &[&user, &limit],
        )?)
    })?;
    let rows = rows
        .iter()
        .map(|r| {
            Ok(Json::obj([
                ("id", Json::str(r.try_get::<_, String>(0)?)),
                ("ownerId", Json::str(r.try_get::<_, String>(1)?)),
                ("name", Json::str(r.try_get::<_, String>(2)?)),
                ("version", Json::int(r.try_get::<_, i64>(3)?)),
                ("state", Json::str(r.try_get::<_, String>(4)?)),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    Ok(Json::Array(rows))
}

/// What a share would include beyond the agent itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Include {
    pub transcripts: bool,
    pub memory: bool,
}

/// `share`: the agent's share as `own_agent_data_controls` holds it, its defaults while no row is kept.
pub fn share(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT share_transcripts, share_memory, {} FROM agents.own_agent_data_controls
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                ms("shared_at")
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    let (transcripts, memory, shared_at) = match rows.first() {
        Some(r) => (
            r.try_get::<_, bool>(0)?,
            r.try_get::<_, bool>(1)?,
            r.try_get::<_, Option<i64>>(2)?,
        ),
        // `DEFAULT_CONTROLS`.
        None => (false, false, None),
    };
    Ok(Json::obj([
        ("shared", Json::Bool(shared_at.is_some())),
        ("includeTranscripts", Json::Bool(transcripts)),
        ("includeMemory", Json::Bool(memory)),
        (
            "sharedAt",
            shared_at.map_or(Json::Null, |t| Json::str(Instant(t).iso())),
        ),
    ]))
}

/// `shareCheck`: what a share would make visible to the agent's co-owners, and how many co-owners it has.
pub fn share_check(
    pool: &Pool,
    agent_id: &str,
    include: Include,
) -> Result<(Vec<&'static str>, i64), OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT count(*)::bigint FROM agents.own_agent_co_owners WHERE agent_id = $1::text::uuid",
            &[&agent_id],
        )?)
    })?;
    let co_owners = match rows.first() {
        Some(r) => r.try_get::<_, i64>(0)?,
        None => 0,
    };
    let mut exposes = Vec::new();
    if include.transcripts {
        exposes.push("transcripts");
    }
    if include.memory {
        exposes.push("memory");
    }
    Ok((exposes, co_owners))
}

/// `{ exposes, coOwners }`, as `own.share.check` answers.
pub fn share_check_json(exposes: &[&str], co_owners: i64) -> Json {
    Json::obj([
        (
            "exposes",
            Json::Array(exposes.iter().map(|e| Json::str(*e)).collect()),
        ),
        ("coOwners", Json::int(co_owners)),
    ])
}

/// `setShare`: shares the agent with its co-owners. A share that exposes private context refuses
/// `agents.privacy.confirm_required` until the person confirms the check; an agent with no co-owner has no one to share
/// with (`agents.share.no_co_owners`). Nothing is stored on a refusal.
pub fn set_share(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    include: Include,
    confirmed: bool,
) -> Result<Json, OwnError> {
    let (exposes, co_owners) = share_check(pool, agent_id, include)?;
    if !exposes.is_empty() && !confirmed {
        return Err(OwnRefusal::new("agents.privacy.confirm_required").into());
    }
    if co_owners == 0 {
        return Err(OwnRefusal::new("agents.share.no_co_owners").into());
    }
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, share_transcripts, share_memory, shared_at, updated_at)
             VALUES ($1::text::uuid, $2::text, $3::bool, $4::bool, now(), now())
             ON CONFLICT (agent_id) DO UPDATE
               SET share_transcripts = EXCLUDED.share_transcripts, share_memory = EXCLUDED.share_memory,
                   shared_at = EXCLUDED.shared_at, updated_at = now()",
            &[&agent_id, &owner_id, &include.transcripts, &include.memory],
        )?;
        Ok(())
    })?;
    share(pool, owner_id, agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "a1111111-1111-4111-8111-111111111111";
    const OTHER: &str = "b2222222-2222-4222-8222-222222222222";

    /// `publishing.test.ts`: "a co-owner is one person: a group, team or business is refused, and so is the owner".
    #[test]
    fn a_co_owner_is_one_person_never_a_group_nor_the_owner() {
        let code = |r: &str| check_co_owner(USER, r).err().map(|e| e.code);
        for group in ["group:TEST-team", "team:abc", "Business:42", "org:x"] {
            assert_eq!(code(group).as_deref(), Some("agents.own.co_owner_group"));
        }
        assert_eq!(
            code(&USER.to_uppercase()).as_deref(),
            Some("agents.own.co_owner_self")
        );
        assert_eq!(
            code("TEST friend").as_deref(),
            Some("agents.own.co_owner_invalid")
        );
        assert_eq!(
            check_co_owner(USER, &format!(" {} ", OTHER.to_uppercase())),
            Ok(OTHER.to_owned())
        );
    }
}
