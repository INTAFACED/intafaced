//! svc-blueprint's refusals and how each becomes a tRPC answer (`toTrpcError` and `blueprintRefusal` in
//! `services/svc-blueprint/src/router.ts`).
//!
//! The catalogue is every `BlueprintError` code (`blueprint-service.ts`) with the tRPC code `toTrpcError` gives it, and
//! every `AttestationSurfaceError` code (`attestations/zero-pii.ts`), each a 400. `tests/refusals.rs` holds both lists and
//! every answer to what the TypeScript router sent for each (`tests/fixtures/refusals.golden.json`).
//!
//! A call mounted with its refusals mapped answers with [`Refusal::mapped`]. `me`, `mentors` and `export` never mapped
//! theirs: whatever they throw is sent as tRPC sends an unknown error, a 500 with the error's own message
//! ([`Refusal::unmapped`]); kept as it is, bug included, so the wire does not move with the port.

use service_kit::trpc::TrpcError;

/// Every `BlueprintError` code, with the tRPC code `toTrpcError` sends it as.
pub const BLUEPRINT_CODES: [(&str, &str); 13] = [
    ("blueprint.not_found", "NOT_FOUND"),
    ("blueprint.crew_not_found", "NOT_FOUND"),
    ("blueprint.crew_full", "CONFLICT"),
    ("blueprint.engine_unavailable", "INTERNAL_SERVER_ERROR"),
    ("blueprint.engine_protocol", "INTERNAL_SERVER_ERROR"),
    ("blueprint.invalid_profile", "INTERNAL_SERVER_ERROR"),
    ("blueprint.crew_capacity_unset", "PRECONDITION_FAILED"),
    ("blueprint.mentor_shortlist_unset", "PRECONDITION_FAILED"),
    ("blueprint.season_unset", "PRECONDITION_FAILED"),
    ("blueprint.share_limit_unset", "PRECONDITION_FAILED"),
    ("blueprint.share_limit_reached", "CONFLICT"),
    ("blueprint.opens_list_limit_unset", "PRECONDITION_FAILED"),
    ("blueprint.open_log_unavailable", "INTERNAL_SERVER_ERROR"),
];

/// Every `AttestationSurfaceError` code: a card surface that would carry PII, or an attestation that is not built.
pub const ATTESTATION_CODES: [&str; 6] = [
    "blueprint.attestation_on_chain_unbuilt",
    "blueprint.attestation_pii_cross_plane_address",
    "blueprint.attestation_pii_custodial_user_id",
    "blueprint.attestation_pii_identity",
    "blueprint.attestation_pii_kyc",
    "blueprint.attestation_threat_model_unmet",
];

/// Everything a handler can refuse with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// `BlueprintError`: one of [`BLUEPRINT_CODES`].
    Blueprint { code: &'static str, message: String },
    /// `AttestationSurfaceError`: one of [`ATTESTATION_CODES`].
    Attestation { code: &'static str, message: String },
    /// A `TRPCError` a handler already shaped, sent as it is.
    Trpc(TrpcError),
    /// Any other failure (a database error, a bug): its message and, when it has one, its code (a SQLSTATE).
    Other {
        message: String,
        code: Option<String>,
    },
}

impl Refusal {
    /// `new BlueprintError(message, code)`; `None` for a code the catalogue does not hold, so none is made up.
    pub fn blueprint(code: &str, message: impl Into<String>) -> Option<Refusal> {
        let (code, _) = BLUEPRINT_CODES.iter().find(|(c, _)| *c == code)?;
        Some(Refusal::Blueprint {
            code,
            message: message.into(),
        })
    }

    /// `new AttestationSurfaceError(message, code)`; `None` for a code the catalogue does not hold.
    pub fn attestation(code: &str, message: impl Into<String>) -> Option<Refusal> {
        let code = ATTESTATION_CODES.iter().find(|c| **c == code)?;
        Some(Refusal::Attestation {
            code,
            message: message.into(),
        })
    }

    /// The answer of a call whose refusals are mapped (`blueprintRefusal`, then `toTrpcError`).
    pub fn mapped(self) -> TrpcError {
        match self {
            Refusal::Trpc(e) => e,
            Refusal::Attestation { code, message } => {
                TrpcError::caused("BAD_REQUEST", message, code)
            }
            Refusal::Blueprint { code, message } => {
                let trpc = BLUEPRINT_CODES
                    .iter()
                    .find(|(c, _)| *c == code)
                    .map_or("INTERNAL_SERVER_ERROR", |(_, t)| *t);
                let message = match code {
                    // 500, not 503: the TypeScript sends INTERNAL_SERVER_ERROR whatever its comment says.
                    "blueprint.engine_unavailable" => "The Neural Engine is unavailable".to_owned(),
                    "blueprint.crew_full" => "That crew is full".to_owned(),
                    "blueprint.engine_protocol" | "blueprint.invalid_profile" => {
                        "The Neural Engine returned an unusable profile".to_owned()
                    }
                    _ => message,
                };
                TrpcError::caused(trpc, message, code)
            }
            Refusal::Other { code, .. } => TrpcError {
                cause: code,
                ..TrpcError::plain("INTERNAL_SERVER_ERROR", "Request failed")
            },
        }
    }

    /// The answer of `me`, `mentors` and `export`: a 500 with the error's own message and code.
    pub fn unmapped(self) -> TrpcError {
        match self {
            Refusal::Trpc(e) => e,
            Refusal::Blueprint { code, message } | Refusal::Attestation { code, message } => {
                TrpcError::caused("INTERNAL_SERVER_ERROR", message, code)
            }
            Refusal::Other { message, code } => TrpcError {
                cause: code,
                ..TrpcError::plain("INTERNAL_SERVER_ERROR", message)
            },
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_code_the_catalogue_does_not_hold_is_never_made() {
        assert!(Refusal::blueprint("blueprint.made_up", "m").is_none());
        assert!(Refusal::attestation("blueprint.not_found", "m").is_none());
        let e = Refusal::blueprint("blueprint.share_limit_reached", "five shares")
            .unwrap()
            .mapped();
        assert_eq!(
            (e.code, e.message.as_str(), e.cause.as_deref()),
            (
                "CONFLICT",
                "five shares",
                Some("blueprint.share_limit_reached")
            )
        );
    }
}
