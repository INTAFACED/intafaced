//! svc-agents' refusals (`services/svc-agents/src/errors.ts`) and how the router's guard answers them
//! (`toTRPCError` in `router.ts`).
//!
//! An `AgentError` carries a machine code (one of `errors_table::CODES`, every `AgentErrorCode`), the copy key a surface
//! renders, and an operator message that never leaves the service. The guard answers with the copy key as the message
//! and the code as `cause.code`, so a client branches on the code and a user reads only the key's copy. A refusal the
//! handler already decided (a `TRPCError`) passes through unchanged; anything else is the engine's outage.
//!
//! The sub-routers (`own`, `team`, `spend`, `fleet`, `oplog`, `alerts`, the route desk, the on-chain routes) each map
//! their refusals with their own guard; each is its slice's to port (`README.md`).

use service_kit::trpc::TrpcError;

use crate::errors_table::CODES;

/// One `AgentError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentError {
    /// The machine code, one of `CODES`.
    pub code: &'static str,
    /// `userMessageKey`: the copy key the answer carries.
    pub user_key: String,
    /// The operator message: logs and spans only, never an answer.
    pub message: String,
}

impl AgentError {
    /// An `AgentError` with a code `errors.ts` declares; `None` for any other, so no code is made up.
    pub fn new(
        code: &str,
        user_key: impl Into<String>,
        message: impl Into<String>,
    ) -> Option<AgentError> {
        let code = CODES.iter().find(|(c, _)| *c == code)?.0;
        Some(AgentError {
            code,
            user_key: user_key.into(),
            message: message.into(),
        })
    }

    /// An `AgentError` the code itself names, with a code `errors.ts` declares (each caller's test holds that its codes
    /// are in `CODES`).
    pub fn declared(
        code: &'static str,
        user_key: impl Into<String>,
        message: impl Into<String>,
    ) -> AgentError {
        AgentError {
            code,
            user_key: user_key.into(),
            message: message.into(),
        }
    }

    /// The tRPC code `toTRPCError` gives the code.
    pub fn trpc_code(&self) -> &'static str {
        match self.code {
            "agents.refused" | "agents.spend_limit" | "agents.spend_limit_unset" => "FORBIDDEN",
            "agents.session_not_found"
            | "agents.agent_not_found"
            | "agents.spend_reservation_not_found" => "NOT_FOUND",
            "agents.provider_unavailable" => "SERVICE_UNAVAILABLE",
            _ => "BAD_REQUEST",
        }
    }
}

/// What a handler can fail with, as the TypeScript's handlers throw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A domain refusal.
    Agent(AgentError),
    /// A refusal already decided (`throw new TRPCError(...)`).
    Trpc(TrpcError),
    /// Anything else: the engine failed.
    Other(String),
}

/// `toTRPCError`: the main router's guard.
pub fn to_trpc(r: Refusal) -> TrpcError {
    match r {
        Refusal::Trpc(e) => e,
        Refusal::Agent(e) => TrpcError::caused(e.trpc_code(), e.user_key, e.code),
        Refusal::Other(_) => {
            TrpcError::plain("INTERNAL_SERVER_ERROR", "agents.error.engine_unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_code_errors_ts_does_not_declare_is_never_made() {
        assert!(AgentError::new("agents.made_up", "k", "m").is_none());
        let e = AgentError::new(
            "agents.session_not_found",
            "agents.refused.session_closed",
            "gone",
        )
        .unwrap();
        assert_eq!(e.trpc_code(), "NOT_FOUND");
    }

    #[test]
    fn the_guard_answers_the_copy_key_with_the_code_as_its_cause() {
        let e = AgentError::new(
            "agents.analytics_range_unset",
            "agents.refused.analytics_from_unset",
            "from is blank",
        )
        .unwrap();
        let t = to_trpc(Refusal::Agent(e));
        assert_eq!(
            (t.code, t.message.as_str(), t.cause.as_deref()),
            (
                "BAD_REQUEST",
                "agents.refused.analytics_from_unset",
                Some("agents.analytics_range_unset")
            )
        );
        let t = to_trpc(Refusal::Other("socket hang up".to_owned()));
        assert_eq!(
            (t.code, t.message.as_str(), t.cause),
            (
                "INTERNAL_SERVER_ERROR",
                "agents.error.engine_unavailable",
                None
            )
        );
    }
}
