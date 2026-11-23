//! What the binary does before it opens the port, in `index.ts`'s order: the schema check, then the boot upsert of
//! the agents' guardrails into `agent_definitions`.
//!
//! The rows are `boot_agents.json`, written by `scripts/record-door.mjs` from the TypeScript boot's own three calls
//! (`registerProductAgentsAtBoot`, `registerCoachAgent`, `registerCatalogueOnlyAgents`) and held to them by
//! `services/svc-agents/src/fleet/boot-agents-rust.test.ts`. Each is written as `runtime.registerAgent` writes it: an
//! insert, or on an existing `agent_id` its version and guardrail replaced and `enabled` kept, so an operator's switch
//! survives a reboot.

use service_kit::json::{self, Json};

use crate::db::{Store, StoreError, with_client};

/// The TypeScript boot's rows, in its order.
const BOOT_AGENTS: &str = include_str!("boot_agents.json");

/// What `index.ts` throws when the schema is not there.
pub const SCHEMA_MISSING: &str =
    "agents schema is missing — run migrations before starting svc-agents";

/// One `agent_definitions` row the boot writes.
#[derive(Debug, Clone, PartialEq)]
pub struct BootAgent {
    pub agent_id: String,
    pub version: i32,
    /// `serialiseGuardrail(guardrail)`, as stored.
    pub guardrail: Json,
    /// The insert's `enabled`; an existing row keeps its own.
    pub enabled: bool,
}

/// The rows the boot upserts, in its order.
pub fn boot_agents() -> Result<Vec<BootAgent>, String> {
    let parsed =
        json::parse(BOOT_AGENTS).map_err(|e| format!("boot_agents.json: {}", e.message))?;
    let Json::Array(rows) = parsed else {
        return Err("boot_agents.json: not a list".to_owned());
    };
    rows.into_iter()
        .map(|row| {
            let field = |k: &str| {
                row.get(k)
                    .ok_or_else(|| format!("boot_agents.json: a row has no {k}"))
            };
            let agent_id = match field("agentId")? {
                Json::String(s) => s.clone(),
                _ => return Err("boot_agents.json: agentId is not a string".to_owned()),
            };
            let version = match field("version")? {
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "a guardrail version is a small whole number, checked just below"
                )]
                Json::Number(n) if n.fract() == 0.0 && *n >= 1.0 && *n <= f64::from(i32::MAX) => {
                    *n as i32
                }
                _ => {
                    return Err(format!(
                        "boot_agents.json: {agent_id}'s version is not a positive integer"
                    ));
                }
            };
            let enabled = match field("enabled")? {
                Json::Bool(b) => *b,
                _ => {
                    return Err(format!(
                        "boot_agents.json: {agent_id}'s enabled is not a boolean"
                    ));
                }
            };
            let guardrail = field("guardrail")?.clone();
            if guardrail.get("agentId") != Some(&Json::str(agent_id.clone())) {
                return Err(format!(
                    "boot_agents.json: {agent_id}'s guardrail names another agent"
                ));
            }
            Ok(BootAgent {
                agent_id,
                version,
                guardrail,
                enabled,
            })
        })
        .collect()
}

/// `SELECT 1 FROM agents.agent_definitions LIMIT 1`: any failure is the missing schema.
pub fn check_schema(store: &Store) -> Result<(), String> {
    let pool = store.pool().map_err(|_| SCHEMA_MISSING.to_owned())?;
    with_client(pool, |c| {
        c.query("SELECT 1 FROM agents.agent_definitions LIMIT 1", &[])?;
        Ok(())
    })
    .map_err(|_| SCHEMA_MISSING.to_owned())
}

/// Upserts every boot row, in order, as `runtime.registerAgent` does; returns the agent ids written.
pub fn register_agents(store: &Store, rows: &[BootAgent]) -> Result<Vec<String>, StoreError> {
    let pool = store.pool()?;
    let mut written = Vec::with_capacity(rows.len());
    for row in rows {
        with_client(pool, |c| {
            c.execute(
                "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled)
                 VALUES ($1, $2, $3::text::jsonb, $4)
                 ON CONFLICT (agent_id) DO UPDATE
                   SET version = EXCLUDED.version,
                       guardrail = EXCLUDED.guardrail,
                       updated_at = now()",
                &[
                    &row.agent_id,
                    &row.version,
                    &row.guardrail.compact(),
                    &row.enabled,
                ],
            )?;
            Ok(())
        })?;
        written.push(row.agent_id.clone());
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn the_boot_writes_the_five_factories_the_coach_and_the_four_catalogue_only_agents_in_order() {
        let ids: Vec<String> = boot_agents()
            .unwrap()
            .into_iter()
            .map(|a| a.agent_id)
            .collect();
        assert_eq!(
            ids,
            [
                "navigator",
                "support",
                "scanner",
                "merchant",
                "copy-intel",
                "coach",
                "launch",
                "growth",
                "portfolio",
                "risk-compliance"
            ]
        );
    }

    #[test]
    fn the_two_catalogue_only_agents_no_customer_can_use_are_inserted_disabled() {
        let off: Vec<String> = boot_agents()
            .unwrap()
            .into_iter()
            .filter(|a| !a.enabled)
            .map(|a| a.agent_id)
            .collect();
        assert_eq!(off, ["portfolio", "risk-compliance"]);
    }

    #[test]
    fn a_store_without_a_database_reads_as_the_missing_schema() {
        assert_eq!(
            check_schema(&Store::Down("no database".to_owned())),
            Err(SCHEMA_MISSING.to_owned())
        );
    }
}
