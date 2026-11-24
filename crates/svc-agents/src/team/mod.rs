//! The `team` slice (`README.md`): a business team's agent roles, pool, project limits, runs on the pool, held actions
//! and usage (`team/routes.ts`, `team/store.ts`, `team/runs.ts`), answered as `teamRouter` answers them.
//!
//! - [`membership`]: svc-bank's team read (`team/membership.ts`), read again at every call and never stored.
//! - [`store`]: roles, the pool and projects (`TeamStore`).
//! - [`runs`]: runs of a member's own agent on the pool, held actions and usage (`TeamRuns`).
//! - [`slice`]: the eleven calls, inside the team router's `guard`.
//!
//! A team run's hold against the member's allocation, the projects and the pool (`team/hold.ts`), the funds a team
//! session is checked against (`team/funds.ts`) and the window owed by the business are the runtime's and the meter's
//! (`runtime/holds.rs`, `runtime/funds.rs`, `metering/meter.rs`), ported with them.

pub mod membership;
pub mod runs;
pub mod slice;
pub mod store;

use service_kit::trpc::TrpcError;

use crate::db::StoreError;
use crate::runtime::RunError;
use membership::TeamMembership;

/// What the slice is built from, once, at start-up (`TeamRouterDeps` past the database and the runtime).
#[derive(Default)]
pub struct Team {
    /// svc-bank's team read: absent (`BANK_URL` unset), every team call refuses `agents.membership_unavailable`.
    pub membership: Option<Box<dyn TeamMembership>>,
}

impl Team {
    /// Nothing wired: no team read.
    pub fn unwired() -> Team {
        Team::default()
    }
}

/// `TeamErrorCode`, each with the answer `routes.ts`'s `STATUS` gives it (`BAD_REQUEST` when it names none).
pub const TEAM_ERRORS: [(&str, &str); 24] = [
    ("agents.membership_unavailable", "SERVICE_UNAVAILABLE"),
    ("agents.team_not_member", "FORBIDDEN"),
    ("agents.business_closed", "FORBIDDEN"),
    ("agents.role_not_member", "FORBIDDEN"),
    ("agents.role_admin_only", "FORBIDDEN"),
    ("agents.role_invalid", "BAD_REQUEST"),
    ("agents.team_role_required", "FORBIDDEN"),
    ("agents.team_change_stale", "CONFLICT"),
    ("agents.pool_limit_unset", "BAD_REQUEST"),
    ("agents.pool_limit_invalid", "BAD_REQUEST"),
    ("agents.pool_allocation_invalid", "BAD_REQUEST"),
    ("agents.pool_over_limit", "BAD_REQUEST"),
    ("agents.pool_unset", "BAD_REQUEST"),
    ("agents.project_name_unset", "BAD_REQUEST"),
    ("agents.project_limit_unset", "BAD_REQUEST"),
    ("agents.project_limit_invalid", "BAD_REQUEST"),
    ("agents.team_agent_not_found", "NOT_FOUND"),
    ("agents.team_tool_not_declared", "BAD_REQUEST"),
    ("agents.team_action_not_found", "NOT_FOUND"),
    ("agents.team_action_closed", "CONFLICT"),
    ("agents.team_four_eyes", "FORBIDDEN"),
    ("agents.team_session_not_found", "NOT_FOUND"),
    ("agents.fee_asset_unset", "SERVICE_UNAVAILABLE"),
    ("agents.capability_unavailable", "SERVICE_UNAVAILABLE"),
];

/// `TeamError`: one of the team's typed refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamError {
    pub code: &'static str,
    pub message: String,
}

/// A `TeamError` by its code; a code `team/errors.ts` does not declare is never made.
pub fn team_error(code: &'static str, message: impl Into<String>) -> TeamError {
    debug_assert!(
        TEAM_ERRORS.iter().any(|(c, _)| *c == code),
        "{code} is not a TeamErrorCode"
    );
    TeamError {
        code,
        message: message.into(),
    }
}

/// What a team handler fails with, as `team/routes.ts`'s `guard` tells them apart.
#[derive(Debug, Clone, PartialEq)]
pub enum TeamFail {
    Team(TeamError),
    /// `OwnAgentRefusal`: its code.
    Own(&'static str),
    /// A runtime failure: a guardrail's refusal, an `AgentError`, or the runtime's own fault.
    Run(RunError),
    /// Anything else, which the guard throws on: tRPC's 500 with its words.
    Thrown(String),
}

impl From<TeamError> for TeamFail {
    fn from(e: TeamError) -> TeamFail {
        TeamFail::Team(e)
    }
}

impl From<RunError> for TeamFail {
    fn from(e: RunError) -> TeamFail {
        TeamFail::Run(e)
    }
}

impl From<StoreError> for TeamFail {
    fn from(e: StoreError) -> TeamFail {
        TeamFail::Thrown(e.message)
    }
}

impl From<postgres::Error> for TeamFail {
    fn from(e: postgres::Error) -> TeamFail {
        TeamFail::from(StoreError::from(e))
    }
}

/// So a team body can run under `transaction_retrying`, which retries a serialization failure or a deadlock.
#[derive(Debug)]
pub enum TeamTx {
    Store(StoreError),
    Fail(TeamFail),
}

impl From<StoreError> for TeamTx {
    fn from(e: StoreError) -> TeamTx {
        TeamTx::Store(e)
    }
}

impl From<postgres::Error> for TeamTx {
    fn from(e: postgres::Error) -> TeamTx {
        TeamTx::Store(StoreError::from(e))
    }
}

impl From<TeamError> for TeamTx {
    fn from(e: TeamError) -> TeamTx {
        TeamTx::Fail(TeamFail::Team(e))
    }
}

impl crate::db::Retryable for TeamTx {
    fn store(&self) -> Option<&StoreError> {
        match self {
            TeamTx::Store(s) => Some(s),
            TeamTx::Fail(_) => None,
        }
    }
}

impl From<TeamTx> for TeamFail {
    fn from(e: TeamTx) -> TeamFail {
        match e {
            TeamTx::Store(s) => TeamFail::from(s),
            TeamTx::Fail(f) => f,
        }
    }
}

fn agent_status(code: &str) -> &'static str {
    match code {
        "agents.session_not_found" => "NOT_FOUND",
        "agents.provider_unavailable" => "SERVICE_UNAVAILABLE",
        _ => "BAD_REQUEST",
    }
}

/// `guard` (`team/routes.ts`): a refusal reaches the client as its code (`message`, and `data.cause.code`); anything
/// else is the router's own failure.
pub fn guard(fail: TeamFail) -> TrpcError {
    match fail {
        TeamFail::Team(e) => {
            let status = TEAM_ERRORS
                .iter()
                .find(|(c, _)| *c == e.code)
                .map_or("BAD_REQUEST", |(_, s)| *s);
            TrpcError::caused(status, e.code, e.code)
        }
        TeamFail::Own(code) => TrpcError::caused("BAD_REQUEST", code, code),
        TeamFail::Run(RunError::Refused { refusal, .. }) => {
            TrpcError::caused("FORBIDDEN", refusal.code, "agents.refused")
        }
        TeamFail::Run(RunError::Agent(d) | RunError::MeteredReplay(d)) => {
            TrpcError::caused(agent_status(d.error.code), d.error.code, d.error.code)
        }
        TeamFail::Run(RunError::Trpc(t)) => t,
        TeamFail::Run(RunError::Store(s)) => TrpcError::plain("INTERNAL_SERVER_ERROR", s.message),
        TeamFail::Run(RunError::Other(m)) | TeamFail::Thrown(m) => {
            TrpcError::plain("INTERNAL_SERVER_ERROR", m)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn each_team_refusal_answers_its_status_with_its_code_as_message_and_cause() {
        let t = guard(TeamFail::Team(team_error(
            "agents.team_change_stale",
            "read it again",
        )));
        assert_eq!(
            (t.code, t.message.as_str(), t.cause.as_deref()),
            (
                "CONFLICT",
                "agents.team_change_stale",
                Some("agents.team_change_stale")
            )
        );
        let t = guard(TeamFail::Team(team_error("agents.pool_over_limit", "over")));
        assert_eq!(t.code, "BAD_REQUEST");
        let t = guard(TeamFail::Own("agents.spend.cap_unset"));
        assert_eq!(
            (t.code, t.cause.as_deref()),
            ("BAD_REQUEST", Some("agents.spend.cap_unset"))
        );
        let t = guard(TeamFail::Thrown("socket hang up".to_owned()));
        assert_eq!(
            (t.code, t.message.as_str(), t.cause),
            ("INTERNAL_SERVER_ERROR", "socket hang up", None)
        );
    }
}
