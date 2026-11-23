//! The owner's own freeze as svc-agents applies it (`own/self-freeze.ts`, `applySelfFreeze` and
//! `subscribeSelfFreezeApplied`; W-security-accounts-03, J-wallet-13 #1 #4). Identity's `selfFreezeApplied` revokes every
//! permission this service keeps for an agent to act for the person and stops their scheduled agent runs, in one
//! transaction recorded under the freeze's id, so a second delivery changes nothing. A revoked permission stays revoked
//! after the lift: the person grants it again. Nothing here moves value or holds a balance.
//!
//! The kit has no JetStream consumer yet, so the binary subscribes to nothing (`README.md`, slice `store`): a delivery is
//! [`on_self_freeze_applied`], which the consumer calls once the kit has one. Its idempotency is the freeze's own record
//! in Postgres, which a redelivery after a restart meets too; the TypeScript's in-memory seen-set adds nothing to it.

use service_kit::json::{self, Json};
use service_kit::pg::Pool;

use super::OwnError;
use super::evals::in_transaction;
use crate::self_freeze::OWNER_FROZEN_SELF;

/// `SelfFreezeApplied`: what one application of a freeze changed, row counts by kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Applied {
    pub tokens_revoked: i64,
    pub consents_revoked: i64,
    pub account_access_ended: i64,
    pub onchain_bindings_revoking: i64,
    pub schedules_cancelled: i64,
    pub triggers_cancelled: i64,
    pub auto_runs_skipped: i64,
    pub session_runs_paused: i64,
    pub test_runs_stopped: i64,
}

const KEYS: [&str; 9] = [
    "tokensRevoked",
    "consentsRevoked",
    "accountAccessEnded",
    "onchainBindingsRevoking",
    "schedulesCancelled",
    "triggersCancelled",
    "autoRunsSkipped",
    "sessionRunsPaused",
    "testRunsStopped",
];

impl Applied {
    fn counts(&self) -> [i64; 9] {
        [
            self.tokens_revoked,
            self.consents_revoked,
            self.account_access_ended,
            self.onchain_bindings_revoking,
            self.schedules_cancelled,
            self.triggers_cancelled,
            self.auto_runs_skipped,
            self.session_runs_paused,
            self.test_runs_stopped,
        ]
    }

    /// In the TypeScript's key order.
    pub fn to_json(&self) -> Json {
        Json::Object(
            KEYS.into_iter()
                .zip(self.counts())
                .map(|(k, n)| (k.to_owned(), Json::int(n)))
                .collect(),
        )
    }

    fn from_json(v: &Json) -> Applied {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a count this service wrote as a whole number"
        )]
        let n = |k: &str| match v.get(k) {
            Some(Json::Number(x)) => *x as i64,
            _ => 0,
        };
        Applied {
            tokens_revoked: n(KEYS[0]),
            consents_revoked: n(KEYS[1]),
            account_access_ended: n(KEYS[2]),
            onchain_bindings_revoking: n(KEYS[3]),
            schedules_cancelled: n(KEYS[4]),
            triggers_cancelled: n(KEYS[5]),
            auto_runs_skipped: n(KEYS[6]),
            session_runs_paused: n(KEYS[7]),
            test_runs_stopped: n(KEYS[8]),
        }
    }
}

/// One freeze as identity announces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Freeze<'a> {
    pub user_id: &'a str,
    pub freeze_id: &'a str,
    pub since: &'a str,
}

/// The statements one application runs, in order, each counting the rows it changed; only the person's own rows.
const STATEMENTS: [&str; 9] = [
    // The agent's own credential: its token's next call fails (token_revoked).
    "UPDATE agents.own_agent_tokens SET revoked_at = now(), updated_at = now()
      WHERE owner_id = $1::text AND revoked_at IS NULL",
    // The person's consent to each class of tool: every class must be granted again.
    "UPDATE agents.own_agent_consents SET revoked_at = now(), updated_at = now()
      WHERE owner_id = $1::text AND revoked_at IS NULL",
    // Access to the person's venue sub-accounts: ended, as a new grant ends the one before it.
    "UPDATE agents.own_agent_account_access SET ended_at = now()
      WHERE owner_id = $1::text AND ended_at IS NULL",
    // The Navigator's session-key bindings: marked revoking, as the person's own revoke does; the chain is still the
    // truth for whether the key is live, and the person signs its on-chain revoke in their wallet.
    "UPDATE agents.navigator_onchain_bindings SET revoke_requested_at = now(), updated_at = now()
      WHERE user_id = $1::text AND revoke_requested_at IS NULL",
    // Schedules and triggers: no further occurrence or event runs the agent. The person makes a new one after the lift.
    "UPDATE agents.own_agent_schedules SET state = 'cancelled', next_due_at = NULL, updated_at = now()
      WHERE owner_id = $1::text AND state = 'active'",
    "UPDATE agents.own_agent_triggers SET state = 'cancelled', updated_at = now()
      WHERE owner_id = $1::text AND state = 'active'",
    // An occurrence already claimed and not yet run settles as skipped by the freeze, so no worker runs it.
    "UPDATE agents.own_agent_auto_runs SET state = 'skipped', code = 'agents.schedule_blocked', reason_code = $2::text,
            updated_at = now()
      WHERE owner_id = $1::text AND state = 'claimed'",
    // A session's background run takes no new step; it stays paused until the person resumes it after the lift.
    "UPDATE agents.session_background_runs SET state = 'paused', updated_at = now()
      WHERE user_id = $1::text AND state IN ('queued', 'running')",
    // A background test run of the person's own agent stops with the freeze's code.
    "UPDATE agents.own_agent_background_runs SET state = 'stopped', stop_code = $2::text, updated_at = now()
      WHERE owner_id = $1::text AND state = 'running'",
];

/// `applySelfFreeze`: applies one freeze, once, in one transaction recorded under the freeze's id. The same freeze again
/// returns what the first application changed (`repeated`) and changes nothing.
pub fn apply_self_freeze(pool: &Pool, freeze: &Freeze<'_>) -> Result<(Applied, bool), OwnError> {
    let lock = format!("agents.self_freeze:{}", freeze.freeze_id);
    in_transaction(pool, |tx| {
        // One application per freeze: two deliveries at once wait here and the second finds the record.
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1::text))", &[&lock])?;
        let seen = tx.query(
            "SELECT applied::text FROM agents.self_freezes_applied WHERE freeze_id = $1::text::uuid",
            &[&freeze.freeze_id],
        )?;
        if let Some(row) = seen.first() {
            let text: String = row.try_get(0)?;
            return Ok(json::parse(&text)
                .map(|v| (Applied::from_json(&v), true))
                .map_err(|e| OwnError::Thrown(e.message)));
        }
        let mut counts = [0i64; 9];
        for (i, statement) in STATEMENTS.iter().enumerate() {
            // Only the statements that name the freeze's code take it.
            let n = if statement.contains("$2") {
                tx.execute(*statement, &[&freeze.user_id, &OWNER_FROZEN_SELF])?
            } else {
                tx.execute(*statement, &[&freeze.user_id])?
            };
            if let Some(slot) = counts.get_mut(i) {
                *slot = i64::try_from(n).unwrap_or(i64::MAX);
            }
        }
        let [
            tokens_revoked,
            consents_revoked,
            account_access_ended,
            onchain_bindings_revoking,
            schedules_cancelled,
            triggers_cancelled,
            auto_runs_skipped,
            session_runs_paused,
            test_runs_stopped,
        ] = counts;
        let applied = Applied {
            tokens_revoked,
            consents_revoked,
            account_access_ended,
            onchain_bindings_revoking,
            schedules_cancelled,
            triggers_cancelled,
            auto_runs_skipped,
            session_runs_paused,
            test_runs_stopped,
        };
        let record = applied.to_json().compact();
        tx.execute(
            "INSERT INTO agents.self_freezes_applied (freeze_id, user_id, since, applied)
             VALUES ($1::text::uuid, $2::text, $3::text::timestamptz, $4::text::jsonb)",
            &[&freeze.freeze_id, &freeze.user_id, &freeze.since, &record],
        )?;
        Ok(Ok((applied, false)))
    })
}

/// The consumer of identity's `selfFreezeApplied` (`subscribeSelfFreezeApplied`, durable
/// `agents-identity-self-freeze-frozen`): one delivery's payload, applied once.
pub fn on_self_freeze_applied(pool: &Pool, payload: &Json) -> Result<(Applied, bool), OwnError> {
    let field = |k: &str| match payload.get(k) {
        Some(Json::String(s)) => s.as_str(),
        _ => "",
    };
    apply_self_freeze(
        pool,
        &Freeze {
            user_id: field("userId"),
            freeze_id: field("freezeId"),
            since: field("since"),
        },
    )
}
