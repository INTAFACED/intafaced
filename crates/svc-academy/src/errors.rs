//! The Academy's refusals and how each becomes a tRPC answer.
//!
//! Every code of `ACADEMY_ERROR_CODES` (`services/svc-academy/src/errors.ts`), with the tRPC code `toTrpcError`
//! (`router.ts`) gives it and whether the answer carries the refusal's own message or the code's user copy
//! (`user-copy.ts`), is one row of `door/errors_table.rs`, generated from the TypeScript's recorded answers. The other
//! refusal types `toTrpcError` knows (owner decision, dual control, approval, ambassador pay and rate authority, prize
//! pool) and a plain failure are [`Refusal`]'s other variants.
//!
//! A guarded call (`guard(...)` in the router) turns a refusal into its answer with [`Refusal::guarded`]; an unguarded
//! one lets it reach tRPC as it is ([`Refusal::unguarded`]): a 500 with the refusal's own message and code.

use service_kit::trpc::TrpcError;

use crate::door::Send;
use crate::door::errors_table::ERRORS;

/// `new AcademyError(message, code)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcademyError {
    pub message: String,
    pub code: String,
}

impl AcademyError {
    pub fn new(message: impl Into<String>, code: &str) -> AcademyError {
        AcademyError {
            message: message.into(),
            code: code.to_owned(),
        }
    }
}

/// Everything a handler can refuse with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// `AcademyError`: one of the catalogue's codes.
    Academy(AcademyError),
    /// `OwnerDecisionError`: a path that waits for the owner's choice (`owner.decision`).
    OwnerDecision(String),
    /// `DualControlError`: a second operator is missing (`missing_operator`).
    DualControl(String),
    /// `ActionApprovalConsumeError`: the approval is missing, unwired or could not be consumed.
    Approval { message: String, code: String },
    /// `AmbassadorPayRefuseError`, `AmbassadorRateAuthorityRefuseError`, `PrizePoolRefuseError`: 412 with their own
    /// message and code.
    Precondition { message: String, code: String },
    /// A `TRPCError` thrown as it is.
    Trpc(TrpcError),
    /// Any other failure (a database error, a bug): its message and, when it has one, its code (a SQLSTATE).
    Internal {
        message: String,
        code: Option<String>,
    },
}

impl From<AcademyError> for Refusal {
    fn from(e: AcademyError) -> Refusal {
        Refusal::Academy(e)
    }
}

/// `userCopy(code)`: the words a customer sees for a code.
pub fn user_copy(code: &str) -> Option<&'static str> {
    ERRORS
        .iter()
        .find(|(c, ..)| *c == code)
        .map(|(_, _, _, copy)| *copy)
}

/// Whether `code` is one of `ACADEMY_ERROR_CODES`.
pub fn is_code(code: &str) -> bool {
    ERRORS.iter().any(|(c, ..)| *c == code)
}

/// The tRPC code a catalogue code is answered with.
fn trpc_code(code: &str) -> Option<(&'static str, Send, &'static str)> {
    ERRORS
        .iter()
        .find(|(c, ..)| *c == code)
        .map(|(_, trpc, send, copy)| (*trpc, *send, *copy))
}

/// `TRPCError`'s codes as `&'static str`, for a code read from the table.
fn static_code(code: &str) -> &'static str {
    match code {
        "BAD_REQUEST" => "BAD_REQUEST",
        "UNAUTHORIZED" => "UNAUTHORIZED",
        "FORBIDDEN" => "FORBIDDEN",
        "NOT_FOUND" => "NOT_FOUND",
        "CONFLICT" => "CONFLICT",
        "PRECONDITION_FAILED" => "PRECONDITION_FAILED",
        "TOO_MANY_REQUESTS" => "TOO_MANY_REQUESTS",
        _ => "INTERNAL_SERVER_ERROR",
    }
}

impl Refusal {
    /// A database failure: a 500 that never shows its text to a guarded caller.
    pub fn db(message: impl Into<String>, sqlstate: Option<String>) -> Refusal {
        Refusal::Internal {
            message: message.into(),
            code: sqlstate,
        }
    }

    /// `toTrpcError(err)`: what a guarded call answers.
    pub fn guarded(&self) -> TrpcError {
        match self {
            Refusal::Trpc(e) => e.clone(),
            Refusal::OwnerDecision(m) => {
                TrpcError::caused("PRECONDITION_FAILED", m.clone(), "owner.decision")
            }
            Refusal::DualControl(m) => {
                TrpcError::caused("PRECONDITION_FAILED", m.clone(), "missing_operator")
            }
            Refusal::Approval { message, code } => TrpcError::caused(
                "PRECONDITION_FAILED",
                format!("{message} [{code}]"),
                code.clone(),
            ),
            Refusal::Precondition { message, code } => {
                TrpcError::caused("PRECONDITION_FAILED", message.clone(), code.clone())
            }
            Refusal::Internal { code, .. } => TrpcError {
                code: "INTERNAL_SERVER_ERROR",
                message: "Request failed".to_owned(),
                intafaced_code: None,
                cause: code.clone(),
            },
            Refusal::Academy(e) => match trpc_code(&e.code) {
                Some((trpc, send, copy)) => {
                    let message = match send {
                        Send::UserCopy => copy.to_owned(),
                        Send::Message => e.message.clone(),
                    };
                    TrpcError::caused(static_code(trpc), message, e.code.clone())
                }
                None => {
                    TrpcError::caused("INTERNAL_SERVER_ERROR", e.message.clone(), e.code.clone())
                }
            },
        }
    }

    /// What tRPC makes of the refusal thrown with no guard: a `TRPCError` as it is, anything else a 500 with its own
    /// message and code.
    pub fn unguarded(&self) -> TrpcError {
        let (message, code) = match self {
            Refusal::Trpc(e) => return e.clone(),
            Refusal::Academy(e) => (e.message.clone(), Some(e.code.clone())),
            Refusal::OwnerDecision(m) => (m.clone(), Some("owner.decision".to_owned())),
            Refusal::DualControl(m) => (m.clone(), Some("missing_operator".to_owned())),
            Refusal::Approval { message, code } | Refusal::Precondition { message, code } => {
                (message.clone(), Some(code.clone()))
            }
            Refusal::Internal { message, code } => (message.clone(), code.clone()),
        };
        TrpcError {
            code: "INTERNAL_SERVER_ERROR",
            message,
            intafaced_code: None,
            cause: code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_one_row() {
        for (i, (code, ..)) in ERRORS.iter().enumerate() {
            assert!(
                !ERRORS.iter().skip(i + 1).any(|(c, ..)| c == code),
                "{code} twice"
            );
        }
        assert_eq!(
            user_copy("academy.room_not_found"),
            Some("We could not find that.")
        );
    }

    #[test]
    fn a_guarded_failure_hides_its_text_and_an_unguarded_one_shows_it() {
        let down = Refusal::db("the database is down", None);
        assert_eq!(down.guarded().message, "Request failed");
        assert_eq!(down.unguarded().message, "the database is down");
        let e = Refusal::from(AcademyError::new(
            "replay: refused",
            "academy.room_not_found",
        ));
        assert_eq!(e.guarded().code, "NOT_FOUND");
        assert_eq!(e.unguarded().code, "INTERNAL_SERVER_ERROR");
        assert_eq!(
            e.unguarded().cause.as_deref(),
            Some("academy.room_not_found")
        );
    }
}
