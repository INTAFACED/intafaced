//! What a person's own agent remembers, and what is kept about them (`own/memory.ts`, AG-builder-02, AG-guardrails-04;
//! J-agents-09 #1-#5): whether memory is on and each item with the run that remembered it, clearing one item, the
//! retention periods and keeping transcripts. A run's `remember` step is the test runs' (`own::test_runs`); the share
//! with co-owners is `own-sharing`'s. Retention periods are the owner's values: a blank one reads "not set" and a
//! write that needs it refuses `agents.retention_unset`; none is invented. Nothing here is a balance.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `OWN_AGENT_RETENTION_KINDS`, in their order, with the environment variable each is stored under.
pub const RETENTION_KINDS: [(&str, &str); 5] = [
    ("action_log", "AGENTS_RETENTION_ACTION_LOG_DAYS"),
    ("memory", "AGENTS_RETENTION_MEMORY_DAYS"),
    ("transcripts", "AGENTS_RETENTION_TRANSCRIPTS_DAYS"),
    ("approvals", "AGENTS_RETENTION_APPROVALS_DAYS"),
    ("usage", "AGENTS_RETENTION_USAGE_DAYS"),
];

/// `RetentionPeriods`: the owner's period in whole days for each kind, or none when blank.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Retention {
    pub days: [Option<i64>; 5],
}

impl Retention {
    /// `retentionPeriods`: the periods the owner stored, leaving out every blank one.
    pub fn from_env(read: impl Fn(&str) -> Option<i64>) -> Retention {
        let mut days = [None; 5];
        for (slot, (_, key)) in days.iter_mut().zip(RETENTION_KINDS) {
            *slot = read(key);
        }
        Retention { days }
    }

    fn of(&self, kind: &str) -> Option<i64> {
        RETENTION_KINDS
            .iter()
            .position(|(k, _)| *k == kind)
            .and_then(|i| self.days.get(i).copied().flatten())
    }
}

/// The data-control row, or its defaults: memory on, nothing kept or shared.
struct Controls {
    memory_enabled: bool,
    keep_transcripts: bool,
}

fn controls(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Controls, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT memory_enabled, keep_transcripts FROM agents.own_agent_data_controls
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
            &[&owner_id, &agent_id],
        )?)
    })?;
    Ok(match rows.first() {
        Some(r) => Controls {
            memory_enabled: r.try_get(0)?,
            keep_transcripts: r.try_get(1)?,
        },
        None => Controls {
            memory_enabled: true,
            keep_transcripts: false,
        },
    })
}

/// `OwnMemoryStore.get`: whether memory is on, and each item with its source run, newest first.
pub fn get(pool: &Pool, owner_id: &str, agent_id: &str, limit: i64) -> Result<Json, OwnError> {
    let enabled = controls(pool, owner_id, agent_id)?.memory_enabled;
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text, text, source_run_id::text, {} FROM agents.own_agent_memory
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY created_at DESC, id
                  LIMIT $3::text::bigint",
                ms("created_at")
            ),
            &[&owner_id, &agent_id, &limit.to_string()],
        )?)
    })?;
    let items = rows
        .iter()
        .map(|r| {
            Ok(Json::obj([
                ("id", Json::str(r.try_get::<_, String>(0)?)),
                ("text", Json::str(r.try_get::<_, String>(1)?)),
                ("sourceRunId", Json::str(r.try_get::<_, String>(2)?)),
                ("createdAt", Json::str(Instant(r.try_get(3)?).iso())),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()?;
    Ok(Json::obj([
        ("enabled", Json::Bool(enabled)),
        ("items", Json::Array(items)),
    ]))
}

/// `OwnMemoryStore.clear`: one delete of the person's own row; another person's item, or one already gone, is not found.
pub fn clear(pool: &Pool, owner_id: &str, agent_id: &str, item_id: &str) -> Result<(), OwnError> {
    let deleted = db::with_client(pool, |c| {
        Ok(c.query(
            "DELETE FROM agents.own_agent_memory
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND id = $3::text::uuid RETURNING id",
            &[&owner_id, &agent_id, &item_id],
        )?
        .len())
    })?;
    if deleted == 0 {
        return Err(OwnRefusal::new("agents.memory.not_found").into());
    }
    Ok(())
}

/// `OwnMemoryStore.setEnabled`.
pub fn set_enabled(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    enabled: bool,
) -> Result<(), OwnError> {
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, memory_enabled, updated_at)
             VALUES ($1::text::uuid, $2::text, $3, now())
             ON CONFLICT (agent_id) DO UPDATE SET memory_enabled = EXCLUDED.memory_enabled, updated_at = now()",
            &[&agent_id, &owner_id, &enabled],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `OwnMemoryStore.privacy`: each period (the owner's value or null), whether transcripts are kept, and memory.
pub fn privacy(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    retention: &Retention,
) -> Result<Json, OwnError> {
    let c = controls(pool, owner_id, agent_id)?;
    Ok(Json::obj([
        (
            "periods",
            Json::Array(
                RETENTION_KINDS
                    .iter()
                    .map(|(kind, _)| {
                        Json::obj([
                            ("kind", Json::str(*kind)),
                            ("days", retention.of(kind).map_or(Json::Null, Json::int)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("keepTranscripts", Json::Bool(c.keep_transcripts)),
        ("memoryEnabled", Json::Bool(c.memory_enabled)),
    ]))
}

/// `OwnMemoryStore.setKeepTranscripts`: keeping them needs the owner's transcript period (blank refuses
/// `agents.retention_unset` and stores nothing); stopping only tightens, so it never needs one.
pub fn set_keep_transcripts(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    keep: bool,
    retention: &Retention,
) -> Result<(), OwnError> {
    if keep && retention.of("transcripts").is_none() {
        return Err(OwnRefusal::with(
            "agents.retention_unset",
            [("kind", "transcripts".to_owned())],
        )
        .into());
    }
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, keep_transcripts, updated_at)
             VALUES ($1::text::uuid, $2::text, $3, now())
             ON CONFLICT (agent_id) DO UPDATE SET keep_transcripts = EXCLUDED.keep_transcripts, updated_at = now()",
            &[&agent_id, &owner_id, &keep],
        )?;
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `memory.test.ts`: "keeps only the retention periods the owner stored; a blank one is left out, never defaulted".
    #[test]
    fn only_the_periods_the_owner_stored_are_kept() {
        let r = Retention::from_env(|k| match k {
            "AGENTS_RETENTION_MEMORY_DAYS" => Some(30),
            "AGENTS_RETENTION_USAGE_DAYS" => Some(365),
            _ => None,
        });
        assert_eq!(r.days, [None, Some(30), None, None, Some(365)]);
        assert_eq!(r.of("transcripts"), None);
        assert_eq!(r.of("usage"), Some(365));
    }
}
