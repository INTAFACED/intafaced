//! The rulebook's refusals in the engine (`engine/rulebook-refuse.ts`): an emergency action (halt, resume, the venue
//! halt and its resume, expiry) needs an operator and evidence; a delisting needs an operator and an owner policy. The
//! engine invents neither. The TypeScript wraps the engine's own methods with these gates on import; the `venue`
//! slice's engine calls them before it moves a market, and passes as evidence the approval its door consumed.
//!
//! Not ported: `listMarket`'s permissionless-listing refusal and `cert-refuse.ts`'s certified and testnet-parity
//! claims, which nothing calls.

use service_kit::json::Json;
use service_kit::schema::js_trim;

use crate::approval::{operator_refuse, read_operator_id};
use crate::book::types::Reject;

pub const MISSING_EVIDENCE: &str = "missing_evidence";
pub const DELIST_POLICY_MISSING: &str = "delist_policy_missing";

/// What an emergency or delisting command carries (`EmergencyCmd`, `DelistCmd`); `None` is absent or null.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cmd {
    pub operator_id: Option<String>,
    pub evidence: Option<String>,
    /// `evidenceRefs` as sent: only a non-blank string counts.
    pub evidence_refs: Option<Vec<Json>>,
    pub policy_id: Option<String>,
    pub policy_version: Option<String>,
}

fn non_blank(raw: Option<&str>) -> bool {
    raw.is_some_and(|s| !js_trim(s).is_empty())
}

/// `hasEvidence(cmd)`: a non-blank `evidence`, or one non-blank string among `evidenceRefs`.
pub fn has_evidence(cmd: &Cmd) -> bool {
    non_blank(cmd.evidence.as_deref())
        || cmd.evidence_refs.as_ref().is_some_and(|refs| {
            refs.iter()
                .any(|r| matches!(r, Json::String(s) if !js_trim(s).is_empty()))
        })
}

/// `evidenceRefuse(cmd)`.
pub fn evidence_refuse(cmd: &Cmd) -> Option<Reject> {
    (!has_evidence(cmd)).then(|| {
        Reject::new(
            MISSING_EVIDENCE,
            "emergency action requires authority and evidence; the engine does not invent evidence",
        )
    })
}

/// `delistPolicyRefuse(cmd)`: a policy id or a policy version.
pub fn delist_policy_refuse(cmd: &Cmd) -> Option<Reject> {
    let has = non_blank(cmd.policy_id.as_deref()) || non_blank(cmd.policy_version.as_deref());
    (!has).then(|| {
        Reject::new(
            DELIST_POLICY_MISSING,
            "delist requires an owner policy; the engine does not invent a corporate action",
        )
    })
}

/// A gate's refusal: the operator it read (none when that is what is missing), and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gated {
    pub operator_id: Option<String>,
    pub rejected: Reject,
}

/// `emergencyGate(cmd)`: the operator first, then the evidence. The operator when both hold.
pub fn emergency_gate(cmd: &Cmd) -> Result<String, Gated> {
    let Some(operator_id) = read_operator_id(cmd.operator_id.as_deref()) else {
        return Err(Gated {
            operator_id: None,
            rejected: operator_refuse(),
        });
    };
    match evidence_refuse(cmd) {
        Some(rejected) => Err(Gated {
            operator_id: Some(operator_id),
            rejected,
        }),
        None => Ok(operator_id),
    }
}

/// The delisting's gate: the operator first, then the owner policy.
pub fn delist_gate(cmd: &Cmd) -> Result<String, Gated> {
    let Some(operator_id) = read_operator_id(cmd.operator_id.as_deref()) else {
        return Err(Gated {
            operator_id: None,
            rejected: operator_refuse(),
        });
    };
    match delist_policy_refuse(cmd) {
        Some(rejected) => Err(Gated {
            operator_id: Some(operator_id),
            rejected,
        }),
        None => Ok(operator_id),
    }
}
