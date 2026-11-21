//! The `own-builder` slice (`PORT.md`): agents a person builds for themselves (`services/svc-agents/src/own/routes.ts`,
//! the drafts, publishing, the assistant, rules, the reviewer, reviews, evals, test runs and tools), answered as the
//! TypeScript answers them, and the unpublished sweep.
//!
//! - [`catalog`]: the templates, the tools a draft may be given, the validator and the findings.
//! - [`store`]: the person's own agents (`own_agents`).
//! - [`assistant`]: drafting with the assistant.
//! - [`slice`]: the calls.
//!
//! A refusal of the slice is an [`OwnRefusal`]: the router's `guard` answers it with its code as the message and the
//! cause, `NOT_FOUND` for `agents.own.not_found` and `BAD_REQUEST` otherwise, unless the call maps it itself.

pub mod assistant;
pub mod catalog;
pub mod slice;
pub mod store;

use service_kit::trpc::TrpcError;

use crate::db::{Store, StoreError};
use service_kit::pg::Pool;

/// The task every run of a person's own agent is routed and priced as.
pub const OWN_RUN_TASK: &str = "own.run";

/// A session of an own agent is `own.<agent id>`, a name no registered agent can take.
pub fn own_session_agent_id(id: &str) -> String {
    format!("own.{id}")
}

/// `OwnAgentRefusal`: a code and its parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnRefusal {
    pub code: String,
    pub params: Vec<(String, String)>,
}

impl OwnRefusal {
    pub fn new(code: &str) -> OwnRefusal {
        OwnRefusal {
            code: code.to_owned(),
            params: Vec::new(),
        }
    }

    pub fn with<const N: usize>(code: &str, params: [(&str, String); N]) -> OwnRefusal {
        OwnRefusal {
            code: code.to_owned(),
            params: params.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        }
    }
}

/// What a call of the slice fails with, as the TypeScript throws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnError {
    /// `OwnAgentRefusal`, which the call's `guard` answers.
    Refusal(OwnRefusal),
    /// A `TRPCError` the handler decided.
    Trpc(TrpcError),
    /// Anything else thrown: tRPC's 500 with its words.
    Thrown(String),
}

impl From<OwnRefusal> for OwnError {
    fn from(r: OwnRefusal) -> OwnError {
        OwnError::Refusal(r)
    }
}
impl From<TrpcError> for OwnError {
    fn from(t: TrpcError) -> OwnError {
        OwnError::Trpc(t)
    }
}
impl From<StoreError> for OwnError {
    fn from(e: StoreError) -> OwnError {
        OwnError::Thrown(e.message)
    }
}
impl From<postgres::Error> for OwnError {
    fn from(e: postgres::Error) -> OwnError {
        OwnError::from(StoreError::from(e))
    }
}

/// `storeOf` / `sqlOf`: a router built without a database refuses every call that needs one as unavailable.
pub fn pool_of(store: &Store) -> Result<&Pool, OwnError> {
    match store {
        Store::Pool(p) => Ok(p),
        Store::Down(_) => Err(OwnError::Trpc(TrpcError::plain(
            "SERVICE_UNAVAILABLE",
            "agents.capability_unavailable",
        ))),
    }
}

/// `guard(fn, codeOf)`: a refusal is answered with its code as message and cause; the rest pass through.
pub fn guard(e: OwnError, code_of: fn(&str) -> Option<&'static str>) -> TrpcError {
    match e {
        OwnError::Refusal(r) => {
            let code = code_of(&r.code).unwrap_or(if r.code == "agents.own.not_found" {
                "NOT_FOUND"
            } else {
                "BAD_REQUEST"
            });
            TrpcError::caused(code, r.code.clone(), r.code)
        }
        OwnError::Trpc(t) => t,
        OwnError::Thrown(m) => TrpcError::plain("INTERNAL_SERVER_ERROR", m),
    }
}

/// `guard`'s default: no call-specific mapping.
pub fn no_mapping(_: &str) -> Option<&'static str> {
    None
}

/// `ownerForbidden`: an owner's account refusing is FORBIDDEN wherever an agent's token meets it.
pub fn owner_forbidden(code: &str) -> Option<&'static str> {
    code.starts_with("agents.identity.owner_")
        .then_some("FORBIDDEN")
}

/// What the slice is built from, once, at start-up (`ownRouter`'s templates and `OwnToolDeps`).
pub struct Own {
    /// `parseOwnTemplates(AGENTS_OWN_TEMPLATES)`.
    pub templates: Vec<&'static str>,
    /// `AGENTS_OWN_ASSISTANT_MODEL`: blank refuses drafting `owner.decision`.
    pub assistant_model: Option<String>,
}

impl Own {
    /// Nothing wired: every template, no owner values.
    pub fn unwired() -> Own {
        Own {
            templates: catalog::template_ids(),
            assistant_model: None,
        }
    }
}
