//! The `ops` slice: the operator's desks over every agent, as `router.ts` `ops`, `oplog/routes.ts`,
//! `alerts/routes.ts` and `fleet/control.ts` answer them, and the two timers that belong to them (the transcript purge
//! and the alert evaluation).
//!
//! - `ops.sessions` (`log`'s neighbour in `router.ts`): every person's sessions, newest first, through the main
//!   router's guard; the list itself is the runtime's (`runtime::reads::list_sessions`).
//! - `opsLog.*` ([`log`]): one customer's agent actions read for a reason from the owner's list, each read audited in
//!   the same transaction.
//! - `opsAlerts.*` ([`alerts`]): alert rules, their evaluation and hand-off, and this environment's policy overrides.
//! - `fleet.*` ([`fleet`]): the registry of every agent, its audited export and the switches.
//!
//! Each sub-router has its own guard: a refusal answers with its code as the message and as `cause.code`, at the
//! status its router's table gives it ([`status_of`]); a call that needs the database and has none answers
//! `agents.capability_unavailable` (`sqlOf`); anything else is the database's own failure.

pub mod alerts;
pub mod fleet;
pub mod log;

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::trpc::TrpcError;

use crate::db::{Retryable, Store, StoreError};
use crate::door::Ctx;
use crate::metering::Metering;
use crate::runtime::{self, RunError, reads};

/// What the operator's desks are built from, once, at start-up: the owner's values, each blank until set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ops {
    /// `AGENTS_LOG_READ_REASONS`, split on commas (`parseReasons`); none is blank.
    pub reasons: Option<Vec<String>>,
    /// `AGENTS_OPS_ACTIONS_LIMIT`.
    pub actions_limit: Option<i64>,
    /// `AGENTS_TRANSCRIPT_RETENTION_DAYS`; 0 keeps nothing, none is blank.
    pub retention_days: Option<i64>,
    /// `AGENTS_REGISTRY_LIST_LIMIT`.
    pub registry_limit: Option<i64>,
    /// `AGENTS_POLICY_BASELINE` (`parsePolicyBaseline`): per class, the loosest choice allowed; a class absent is blank.
    pub baseline: PolicyBaseline,
}

impl Ops {
    /// Every owner value blank, as the TypeScript router is built with no `opsLog`, `fleet` or `policyBaseline`.
    pub fn unwired() -> Ops {
        Ops::default()
    }

    /// The owner's values from the environment; a malformed baseline stops the start, never a call.
    pub fn from_env(
        reasons: Option<&str>,
        actions_limit: Option<i64>,
        retention_days: Option<i64>,
        registry_limit: Option<i64>,
        baseline: Option<&str>,
    ) -> Result<Ops, String> {
        Ok(Ops {
            reasons: parse_reasons(reasons),
            actions_limit,
            retention_days,
            registry_limit,
            baseline: parse_policy_baseline(baseline)?,
        })
    }
}

/// `parseReasons`: the owner's comma-separated list, trimmed, empties dropped, each once in its first place; blank (or
/// only commas) is unset.
pub fn parse_reasons(raw: Option<&str>) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for r in raw.unwrap_or("").split(',') {
        let r = service_kit::schema::js_trim(r);
        if !r.is_empty() && !out.iter().any(|o| o == r) {
            out.push(r.to_owned());
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The data classes, rule choices and the owner's baseline are the own agent's (`own::gates`), read here as they are.
pub use crate::own::gates::{
    DATA_CLASSES, PolicyBaseline, RULE_CHOICES, looseness, parse_policy_baseline, stricter,
};

/// What a sub-router's handler fails with.
#[derive(Debug, Clone, PartialEq)]
pub enum OpsError {
    /// A refusal by its code (`OpsLogRefusal`, `AlertRefusal`, `FleetRefusal`).
    Refused(&'static str),
    /// `sqlOf` with no database: `agents.capability_unavailable`.
    Unavailable,
    /// The database failed.
    Store(StoreError),
}

impl From<StoreError> for OpsError {
    fn from(e: StoreError) -> OpsError {
        OpsError::Store(e)
    }
}
impl From<postgres::Error> for OpsError {
    fn from(e: postgres::Error) -> OpsError {
        OpsError::Store(StoreError::from(e))
    }
}
impl Retryable for OpsError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            OpsError::Store(s) => Some(s),
            _ => None,
        }
    }
}

/// The tRPC code each sub-router's `STATUS` table gives a refusal.
pub fn status_of(code: &str) -> &'static str {
    match code {
        "agents.log_read_reason_unset"
        | "agents.ops_actions_limit_unset"
        | "agents.transcript_retention_unset"
        | "agents.baseline_value_unset"
        | "agents.registry_list_limit_unset" => "PRECONDITION_FAILED",
        "agents.transcript_not_kept"
        | "agents.action_not_found"
        | "agents.alert_rule_not_found"
        | "agents.agent_not_found" => "NOT_FOUND",
        "agents.log_read_request_reused"
        | "agents.alert_rule_name_taken"
        | "agents.fleet_not_quarantined"
        | "agents.fleet_already_quarantined"
        | "agents.fleet_kind_not_off"
        | "agents.fleet_kind_already_off"
        | "agents.fleet_owner_present"
        | "agents.fleet_request_reused" => "CONFLICT",
        "agents.log_read_person_only"
        | "agents.alerts_person_only"
        | "agents.fleet_person_only" => "FORBIDDEN",
        _ => "BAD_REQUEST",
    }
}

/// A sub-router's `guard`: a refusal is its code at its status; anything else is not a refusal.
pub fn to_trpc(e: OpsError) -> TrpcError {
    match e {
        OpsError::Refused(code) => TrpcError::caused(status_of(code), code, code),
        OpsError::Unavailable => {
            TrpcError::plain("SERVICE_UNAVAILABLE", "agents.capability_unavailable")
        }
        OpsError::Store(s) => TrpcError::plain("INTERNAL_SERVER_ERROR", s.message),
    }
}

/// `sqlOf(sql)`.
pub fn pool(store: &Store) -> Result<&Pool, OpsError> {
    store.pool().map_err(|_| OpsError::Unavailable)
}

/// The signed operator (`ctx.principal.userId`); the door has already required one.
pub fn operator<'a>(ctx: &'a Ctx<'_>) -> &'a str {
    ctx.principal.map_or("", |p| p.user_id.as_str())
}

/// An optional input string: absent or not a string is none.
pub fn text<'a>(ctx: &'a Ctx<'_>, key: &str) -> Option<&'a str> {
    ctx.input.get(key).as_str()
}

/// A timestamp column as the TypeScript's `Date` prints it.
pub fn iso(ms: i64) -> Json {
    Json::str(service_kit::time::Instant(ms).iso())
}

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    m: &Metering,
    ops: &Ops,
) -> Result<Option<Json>, TrpcError> {
    let path = ctx.call.path;
    if path == "ops.sessions" {
        return sessions(ctx, store, m).map(Some).map_err(runtime::to_trpc);
    }
    let out = if let Some(rest) = path.strip_prefix("opsLog.") {
        log::handle(rest, ctx, store, ops)
    } else if let Some(rest) = path.strip_prefix("opsAlerts.") {
        alerts::handle(rest, ctx, store, m, ops)
    } else if let Some(rest) = path.strip_prefix("fleet.") {
        fleet::handle(rest, ctx, store, ops)
    } else {
        return Err(TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            format!("svc-agents in Rust: {path} is not an ops call"),
        ));
    };
    out.map(Some).map_err(to_trpc)
}

/// `ops.sessions`: every person's sessions, newest first, under the main router's guard. The database is asked for
/// first (`if (!sql) throw`), then the limit, then the cursor (`listSessions`).
fn sessions(ctx: &Ctx<'_>, store: &Store, m: &Metering) -> Result<Json, RunError> {
    let p = store
        .pool()
        .map_err(|_| RunError::Other("agents sql is unset".to_owned()))?;
    let limit = reads::page_limit(
        ctx.input.get("limit").as_number(),
        "agents.ops_sessions_limit_unset",
        "ops sessions",
    )?;
    // `new Date(input.from)`: the instant to the millisecond, as the TypeScript passes it.
    let day = |key: &str| {
        text(ctx, key)
            .and_then(service_kit::time::js_date)
            .map(|i| i.iso())
    };
    let (from, to) = (day("from"), day("to"));
    reads::list_sessions(
        p,
        &reads::ListSessions {
            user_id: text(ctx, "userId"),
            agent_id: text(ctx, "agentId"),
            status: text(ctx, "status"),
            from: from.as_deref(),
            to: to.as_deref(),
            limit,
            cursor: text(ctx, "cursor"),
            fee_asset_id: &m.fee_asset_id,
        },
        true,
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_reasons_are_trimmed_once_each_and_blank_is_unset() {
        assert_eq!(parse_reasons(None), None);
        assert_eq!(parse_reasons(Some(" , ,")), None);
        assert_eq!(
            parse_reasons(Some(" a ,b,a,, c")),
            Some(vec!["a".to_owned(), "b".to_owned(), "c".to_owned()])
        );
    }

    #[test]
    fn the_baseline_is_an_object_of_known_classes_and_choices() {
        assert_eq!(
            parse_policy_baseline(Some("  ")).unwrap(),
            PolicyBaseline::default()
        );
        assert_eq!(
            parse_policy_baseline(Some(r#"{"own_data":"ask_before"}"#))
                .unwrap()
                .of("own_data"),
            Some("ask_before")
        );
        assert_eq!(
            parse_policy_baseline(Some("{")).unwrap_err(),
            "AGENTS_POLICY_BASELINE is not JSON"
        );
        assert_eq!(
            parse_policy_baseline(Some("[]")).unwrap_err(),
            "AGENTS_POLICY_BASELINE must be an object"
        );
        assert!(parse_policy_baseline(Some(r#"{"x":"hand_off"}"#)).is_err());
        assert!(parse_policy_baseline(Some(r#"{"own_data":"maybe"}"#)).is_err());
    }

    #[test]
    fn the_stricter_choice_wins() {
        assert_eq!(stricter("act_on_request", "ask_before"), "ask_before");
        assert_eq!(stricter("hand_off", "act_without_asking"), "hand_off");
    }
}
